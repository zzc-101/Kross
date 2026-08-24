package com.kross.identity;

import com.kross.api.ApiException;
import com.kross.catalog.CredentialVault;
import com.kross.config.KrossProperties;
import com.kross.identity.dto.PlatformSsoView;
import com.kross.identity.dto.UpdateSsoRequest;
import com.kross.identity.entity.PlatformSettings;
import com.kross.identity.entity.User;
import com.nimbusds.jwt.JWTClaimsSet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

@Service
@RequiredArgsConstructor
public class SsoService {
  static final String STATE_ATTR = "kross.sso.state";
  static final String NONCE_ATTR = "kross.sso.nonce";
  static final String VERIFIER_ATTR = "kross.sso.verifier";
  static final String REDIRECT_ATTR = "kross.sso.redirect";
  static final String RETURN_ATTR = "kross.sso.return";

  private final IdentityMapper identities;
  private final AuthService auth;
  private final OidcClient oidc;
  private final CredentialVault vault;
  private final KrossProperties properties;
  private final SecureRandom random = new SecureRandom();

  public PlatformSsoView view(HttpServletRequest request) {
    auth.requireSuperAdmin();
    PlatformSettings settings = settings();
    String redirectUri = callbackUri(request);
    return new PlatformSsoView(
        Boolean.TRUE.equals(settings.getSsoEnabled()),
        settings.getSsoDisplayName(),
        settings.getSsoIssuer(),
        settings.getSsoClientId(),
        Optional.ofNullable(settings.getSsoClientSecretCipher()).filter(value -> !value.isBlank()).isPresent(),
        redirectUri,
        List.of());
  }

  @Transactional
  public PlatformSsoView update(UpdateSsoRequest request, HttpServletRequest http) {
    auth.requireSuperAdmin();
    PlatformSettings current = settings();
    boolean enabled = Optional.ofNullable(request.enabled()).orElse(Boolean.TRUE.equals(current.getSsoEnabled()));
    String displayName = Optional.ofNullable(request.displayName()).map(String::trim).filter(value -> !value.isBlank())
        .orElse(current.getSsoDisplayName());
    String issuer = Optional.ofNullable(request.issuer()).map(String::trim).filter(value -> !value.isBlank())
        .orElse(current.getSsoIssuer());
    String clientId = Optional.ofNullable(request.clientId()).map(String::trim).filter(value -> !value.isBlank())
        .orElse(current.getSsoClientId());
    Optional<String> secret = Optional.ofNullable(request.clientSecret()).map(String::trim).filter(value -> !value.isBlank());
    boolean secretConfigured = secret.isPresent()
        || Optional.ofNullable(current.getSsoClientSecretCipher()).filter(value -> !value.isBlank()).isPresent();
    if (enabled) {
      if (issuer == null || clientId == null || !secretConfigured) {
        throw ApiException.invalidRequest("Issuer, client ID and client secret are required to enable SSO");
      }
      oidc.discover(issuer);
    }
    identities.updateSsoSettings(
        enabled,
        displayName,
        issuer == null || issuer.isBlank() ? null : OidcClient.normalizeIssuer(issuer),
        clientId,
        secret.map(vault::encryptText).orElse(null));
    return view(http);
  }

  public String start(HttpServletRequest request) {
    PlatformSettings settings = requireEnabled();
    OidcClient.Discovery discovery = oidc.discover(settings.getSsoIssuer());
    String redirectUri = callbackUri(request);
    String state = randomToken();
    String nonce = randomToken();
    String verifier = randomToken();
    HttpSession session = request.getSession(true);
    session.setAttribute(STATE_ATTR, state);
    session.setAttribute(NONCE_ATTR, nonce);
    session.setAttribute(VERIFIER_ATTR, verifier);
    session.setAttribute(REDIRECT_ATTR, redirectUri);
    rememberReturnPath(request, session);
    return oidc.authorizationUrl(
        discovery,
        settings.getSsoClientId(),
        redirectUri,
        state,
        nonce,
        codeChallenge(verifier));
  }

  @Transactional
  public User complete(HttpServletRequest request, String code, String state) {
    PlatformSettings settings = requireEnabled();
    HttpSession session = Optional.ofNullable(request.getSession(false))
        .orElseThrow(() -> new ApiException("sso_state_invalid", "SSO session expired", 401));
    request.setAttribute(
        RETURN_ATTR,
        sanitizeReturnPath(Optional.ofNullable(session.getAttribute(RETURN_ATTR)).map(Object::toString).orElse(null)));
    String expectedState = Optional.ofNullable(session.getAttribute(STATE_ATTR)).map(Object::toString).orElse("");
    String nonce = Optional.ofNullable(session.getAttribute(NONCE_ATTR)).map(Object::toString).orElse("");
    String verifier = Optional.ofNullable(session.getAttribute(VERIFIER_ATTR)).map(Object::toString).orElse("");
    String redirectUri = Optional.ofNullable(session.getAttribute(REDIRECT_ATTR)).map(Object::toString)
        .orElse(callbackUri(request));
    session.removeAttribute(STATE_ATTR);
    session.removeAttribute(NONCE_ATTR);
    session.removeAttribute(VERIFIER_ATTR);
    session.removeAttribute(REDIRECT_ATTR);
    session.removeAttribute(RETURN_ATTR);
    if (expectedState.isBlank() || !expectedState.equals(Optional.ofNullable(state).orElse(""))) {
      throw new ApiException("sso_state_invalid", "SSO state mismatch", 401);
    }
    String secret = vault.decryptText(Optional.ofNullable(settings.getSsoClientSecretCipher())
        .orElseThrow(() -> new ApiException("sso_not_configured", "SSO client secret is missing", 500)));
    OidcClient.Discovery discovery = oidc.discover(settings.getSsoIssuer());
    JWTClaimsSet claims = oidc.exchange(
        discovery,
        settings.getSsoClientId(),
        secret,
        redirectUri,
        Optional.ofNullable(code).filter(value -> !value.isBlank())
            .orElseThrow(() -> new ApiException("sso_token_failed", "Missing authorization code", 401)),
        verifier,
        nonce);
    return provision(discovery.issuer(), claims);
  }

  private User provision(String issuer, JWTClaimsSet claims) {
    String subject = Optional.ofNullable(claims.getSubject()).filter(value -> !value.isBlank())
        .orElseThrow(() -> new ApiException("sso_token_failed", "ID token is missing subject", 401));
    Optional<String> email = AuthCredentials.optionalEmail(stringClaim(claims, "email"))
        .filter(value -> Boolean.TRUE.equals(booleanClaim(claims, "email_verified")));
    String displayName = Optional.ofNullable(stringClaim(claims, "name")).filter(value -> !value.isBlank())
        .or(() -> email)
        .orElse(subject);
    if (displayName.length() > 64) {
      displayName = displayName.substring(0, 64);
    }
    String avatarUrl = AuthCredentials.optionalAvatarUrl(stringClaim(claims, "picture"), false).orElse(null);
    Optional<User> bound = identities.findUserBySso(issuer, subject);
    if (bound.isPresent()) {
      return requireActive(bound.get());
    }
    Optional<User> byEmail = email.flatMap(identities::findUserByEmail);
    if (byEmail.isPresent()) {
      return bindExisting(byEmail.get(), email.orElse(null), issuer, subject, displayName, avatarUrl);
    }
    String derived = AuthCredentials.usernameFromClaims(
        stringClaim(claims, "preferred_username"),
        email.orElse(null),
        subject);
    String username = uniqueUsername(derived);
    try {
      identities.insertUser(
          UUID.randomUUID().toString(),
          username,
          AuthCredentials.requireDisplayName(displayName),
          null,
          "user",
          email.orElse(null),
          issuer,
          subject,
          avatarUrl);
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("username_taken", "This username is already registered");
    }
    return identities.findUserBySso(issuer, subject)
        .orElseThrow(() -> ApiException.conflict("user_create_failed", "Failed to create user"));
  }

  private User bindExisting(User user, String email, String issuer, String subject, String displayName, String avatarUrl) {
    User active = requireActive(user);
    identities.bindSso(active.getId(), email, issuer, subject, AuthCredentials.requireDisplayName(displayName), avatarUrl);
    return identities.findUserById(active.getId()).orElse(active);
  }

  private String uniqueUsername(String base) {
    String candidate = AuthCredentials.tryUsername(base).orElse("uuser");
    for (int index = 0; index < 20; index++) {
      String username = index == 0 ? candidate : trimUsername(candidate + index);
      if (identities.findUserByUsername(username).isEmpty()) {
        return username;
      }
    }
    return trimUsername(candidate + Integer.toHexString(random.nextInt()));
  }

  private static String trimUsername(String username) {
    return username.length() <= 32 ? username : username.substring(0, 32);
  }

  private PlatformSettings requireEnabled() {
    PlatformSettings settings = settings();
    if (!Boolean.TRUE.equals(settings.getSsoEnabled())
        || Optional.ofNullable(settings.getSsoIssuer()).filter(value -> !value.isBlank()).isEmpty()
        || Optional.ofNullable(settings.getSsoClientId()).filter(value -> !value.isBlank()).isEmpty()
        || Optional.ofNullable(settings.getSsoClientSecretCipher()).filter(value -> !value.isBlank()).isEmpty()) {
      throw new ApiException("sso_not_configured", "SSO is not enabled", 403);
    }
    return settings;
  }

  private PlatformSettings settings() {
    return identities.findPlatformSettings()
        .orElseThrow(() -> new ApiException("sso_not_configured", "Platform settings are missing", 500));
  }

  private static User requireActive(User user) {
    if (!"active".equals(Optional.ofNullable(user.getStatus()).orElse(""))) {
      throw new ApiException("account_disabled", "This account is disabled", 403);
    }
    return user;
  }

  public String returnPath(HttpServletRequest request) {
    return sanitizeReturnPath(
        Optional.ofNullable(request.getAttribute(RETURN_ATTR)).map(Object::toString)
            .or(() -> Optional.ofNullable(request.getSession(false))
                .map(session -> session.getAttribute(RETURN_ATTR))
                .map(Object::toString))
            .orElse(null));
  }

  private void rememberReturnPath(HttpServletRequest request, HttpSession session) {
    String path = sanitizeReturnPath(request.getParameter("next"));
    session.setAttribute(RETURN_ATTR, path);
    request.setAttribute(RETURN_ATTR, path);
  }

  private static String sanitizeReturnPath(String raw) {
    if ("/admin".equals(raw) || "/admin/".equals(raw)) {
      return "/admin/";
    }
    if (raw != null && raw.startsWith("/invite/")) {
      String token = raw.substring("/invite/".length());
      if (!token.isBlank() && token.indexOf('/') < 0 && token.indexOf('?') < 0 && token.indexOf('#') < 0
          && token.matches("[A-Za-z0-9_-]{8,128}")) {
        return "/invite/" + token;
      }
    }
    return "/";
  }

  private String callbackUri(HttpServletRequest request) {
    return ServletUriComponentsBuilder.fromRequest(request)
        .replacePath(properties.getApi().getPrefix() + "/auth/sso/callback")
        .replaceQuery(null)
        .build()
        .toUriString();
  }

  private String randomToken() {
    byte[] bytes = new byte[32];
    random.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  private static String codeChallenge(String verifier) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
      return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }

  private static Boolean booleanClaim(JWTClaimsSet claims, String name) {
    try {
      return claims.getBooleanClaim(name);
    } catch (Exception error) {
      return null;
    }
  }

  private static String stringClaim(JWTClaimsSet claims, String name) {
    try {
      return claims.getStringClaim(name);
    } catch (Exception error) {
      return null;
    }
  }
}
