package com.kross.identity;

import com.kross.agent.AgentService;
import com.kross.api.ApiException;
import com.kross.api.PageResponse;
import com.kross.config.KrossProperties;
import com.kross.identity.dto.AcceptInviteRequest;
import com.kross.identity.dto.AuthConfigView;
import com.kross.identity.dto.CreateUserRequest;
import com.kross.identity.dto.IdentityViews;
import com.kross.identity.dto.InvitePreviewView;
import com.kross.identity.dto.LoginRequest;
import com.kross.identity.dto.MeResponse;
import com.kross.identity.dto.PlatformSettingsView;
import com.kross.identity.dto.RegisterRequest;
import com.kross.identity.dto.UpdatePlatformRequest;
import com.kross.identity.dto.UserAccountView;
import com.kross.identity.entity.Organization;
import com.kross.identity.entity.OrganizationInvite;
import com.kross.identity.entity.PlatformSettings;
import com.kross.identity.entity.User;
import com.kross.support.Tokens;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.context.annotation.Lazy;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {
  private final IdentityMapper identities;
  private final IdentityService identityService;
  private final OrganizationAccess access;
  private final PasswordEncoder passwords;
  private final AgentService agents;
  private final KrossProperties properties;
  private final String dummyPasswordHash;

  public AuthService(
      IdentityMapper identities,
      IdentityService identityService,
      OrganizationAccess access,
      PasswordEncoder passwords,
      @Lazy AgentService agents,
      KrossProperties properties) {
    this.identities = identities;
    this.identityService = identityService;
    this.access = access;
    this.passwords = passwords;
    this.agents = agents;
    this.properties = properties;
    this.dummyPasswordHash = passwords.encode("kross-dummy-password-not-valid");
  }

  public AuthConfigView config() {
    PlatformSettings settings = identities.findPlatformSettings().orElse(null);
    boolean ssoEnabled = Optional.ofNullable(settings).map(PlatformSettings::getSsoEnabled).orElse(false);
    String ssoName = Optional.ofNullable(settings)
        .map(PlatformSettings::getSsoDisplayName)
        .filter(value -> !value.isBlank())
        .orElse("企业账号");
    return new AuthConfigView(
        identities.isRegistrationEnabled(),
        identities.countUsers() == 0,
        identities.countOrganizations() > 0,
        ssoEnabled,
        ssoEnabled ? ssoName : null);
  }

  @Transactional
  public MeResponse register(RegisterRequest request) {
    boolean bootstrap = identities.countUsers() == 0;
    if (bootstrap) {
      if (!Boolean.TRUE.equals(identities.lockBootstrap())) {
        throw ApiException.conflict("registration_busy", "Another signup is in progress");
      }
      bootstrap = identities.countUsers() == 0;
    }
    if (!bootstrap && identities.isSsoEnabled()) {
      throw new ApiException("sso_required", "Sign in with SSO", 403);
    }
    if (!bootstrap && !identities.isRegistrationEnabled()) {
      throw new ApiException("registration_disabled", "Self-service registration is disabled", 403);
    }
    String username = AuthCredentials.requireUsername(request.username());
    String password = AuthCredentials.requirePassword(request.password());
    String displayName = AuthCredentials.requireDisplayName(
        Optional.ofNullable(request.displayName()).filter(value -> !value.isBlank()).orElse(username));
    insertAccount(username, displayName, password, bootstrap ? "super_admin" : "user");
    User created = identities.findUserByUsername(username)
        .orElseThrow(() -> ApiException.conflict("user_create_failed", "Failed to create user"));
    bind(created);
    return identityService.me();
  }

  public MeResponse login(LoginRequest request) {
    String username = AuthCredentials.requireUsername(request.username());
    String password = AuthCredentials.requirePassword(request.password());
    Optional<User> candidate = identities.findUserByUsername(username);
    String hash = candidate
        .map(User::getPasswordHash)
        .filter(value -> !value.isBlank())
        .orElse(dummyPasswordHash);
    if (!passwords.matches(password, hash)) {
      throw invalidCredentials();
    }
    User user = candidate.orElseThrow(AuthService::invalidCredentials);
    if (!"active".equals(Optional.ofNullable(user.getStatus()).orElse(""))) {
      throw new ApiException("account_disabled", "This account is disabled", 403);
    }
    if (identities.isSsoEnabled() && !"super_admin".equals(user.getPlatformRole())) {
      throw new ApiException("sso_required", "Sign in with SSO", 403);
    }
    bind(user);
    return identityService.me();
  }

  public PlatformSettingsView platform() {
    requireSuperAdmin();
    return platformView();
  }

  @Transactional
  public PlatformSettingsView updatePlatform(UpdatePlatformRequest request) {
    requireSuperAdmin();
    Optional.ofNullable(request.registrationEnabled()).ifPresent(identities::setRegistrationEnabled);
    Optional.ofNullable(request.knowledgeEnabled()).ifPresent(identities::setKnowledgeEnabled);
    return platformView();
  }

  private PlatformSettingsView platformView() {
    return new PlatformSettingsView(
        identities.isRegistrationEnabled(),
        identities.isKnowledgeEnabled(),
        properties.getKnowledge().isConfigured());
  }

  public PageResponse<UserAccountView> listUsers(int page, int pageSize) {
    requireSuperAdmin();
    int size = Math.min(Math.max(pageSize, 1), 100);
    int offset = (Math.max(page, 1) - 1) * size;
    return new PageResponse<>(
        identities.listUsers(size, offset).stream().map(IdentityViews::account).toList(),
        Math.max(page, 1),
        size,
        identities.countUsers());
  }

  @Transactional
  public UserAccountView createUser(CreateUserRequest request) {
    requireSuperAdmin();
    String username = AuthCredentials.requireUsername(request.username());
    String password = AuthCredentials.requirePassword(request.password());
    String displayName = AuthCredentials.requireDisplayName(
        Optional.ofNullable(request.displayName()).filter(value -> !value.isBlank()).orElse(username));
    insertAccount(username, displayName, password, "user");
    return identities.findUserByUsername(username).map(IdentityViews::account)
        .orElseThrow(() -> ApiException.conflict("user_create_failed", "Failed to create user"));
  }

  public Identity authenticate(String userId, String username, String displayName) {
    identities.upsertUser(userId, username, displayName);
    return identities.findUserById(userId)
        .map(AuthService::toIdentity)
        .orElseGet(() -> new Identity(userId, username, displayName, "user"));
  }

  private OrganizationInvite requireInvite(String token) {
    String value = Optional.ofNullable(token).map(String::trim).filter(item -> !item.isBlank())
        .orElseThrow(() -> ApiException.notFound("Invite"));
    return identities.findInviteByHash(Tokens.sha256Hex(value))
        .orElseThrow(() -> ApiException.notFound("Invite"));
  }

  private User resolveInviteUser(Optional<AcceptInviteRequest> request) {
    Optional<Identity> signedIn = access.findCurrentIdentity();
    if (signedIn.isPresent()) {
      return identities.findUserById(signedIn.get().userId())
          .filter(user -> "active".equals(Optional.ofNullable(user.getStatus()).orElse("")))
          .orElseThrow(() -> new ApiException("account_disabled", "This account is disabled", 403));
    }
    AcceptInviteRequest body = request.orElseThrow(
        () -> new ApiException("unauthenticated", "Sign in or provide credentials", 401));
    if (identities.isSsoEnabled()) {
      throw new ApiException("sso_required", "Sign in with SSO, then open this invite link again", 403);
    }
    String username = AuthCredentials.requireUsername(body.username());
    String password = AuthCredentials.requirePassword(body.password());
    Optional<User> existing = identities.findUserByUsername(username);
    if (existing.isPresent()) {
      User user = existing.get();
      if (!"active".equals(Optional.ofNullable(user.getStatus()).orElse(""))) {
        throw new ApiException("account_disabled", "This account is disabled", 403);
      }
      String hash = Optional.ofNullable(user.getPasswordHash()).filter(value -> !value.isBlank())
          .orElseThrow(AuthService::invalidCredentials);
      if (!passwords.matches(password, hash)) {
        throw invalidCredentials();
      }
      return user;
    }
    String displayName = AuthCredentials.requireDisplayName(
        Optional.ofNullable(body.displayName()).filter(value -> !value.isBlank()).orElse(username));
    insertAccount(username, displayName, password, "user");
    return identities.findUserByUsername(username)
        .orElseThrow(() -> ApiException.conflict("user_create_failed", "Failed to create user"));
  }

  private void insertAccount(String username, String displayName, String password, String platformRole) {
    AuthCredentials.requireBcryptPassword(password);
    try {
      identities.insertUser(
          UUID.randomUUID().toString(),
          username,
          displayName,
          passwords.encode(password),
          platformRole,
          null,
          null,
          null,
          null);
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("username_taken", "This username is already registered");
    }
  }

  private void bind(User user) {
    Identity identity = toIdentity(user);
    SecurityContextHolder.getContext()
        .setAuthentication(new UsernamePasswordAuthenticationToken(identity, null, List.of()));
  }

  public InvitePreviewView previewInvite(String token) {
    OrganizationInvite invite = requireInvite(token);
    Organization organization = identities.findOrganization(invite.getOrganizationId())
        .orElseThrow(() -> ApiException.notFound("Invite"));
    return new InvitePreviewView(
        organization.getName(),
        organization.getSlug(),
        invite.getRole(),
        invite.getExpiresAt(),
        invite.getAcceptedAt() != null);
  }

  @Transactional
  public MeResponse acceptInvite(String token, Optional<AcceptInviteRequest> request) {
    OrganizationInvite invite = requireInvite(token);
    if (invite.getAcceptedAt() != null) {
      throw ApiException.conflict("invite_used", "Invite already accepted");
    }
    if (invite.getExpiresAt().isBefore(Instant.now())) {
      throw ApiException.conflict("invite_expired", "Invite expired");
    }
    Organization organization = identities.findOrganization(invite.getOrganizationId())
        .filter(row -> "active".equals(row.getStatus()))
        .orElseThrow(() -> new ApiException("organization_unavailable", "Organization is not active", 403));
    User user = resolveInviteUser(request);
    String membershipId = UUID.randomUUID().toString();
    try {
      identities.insertMembership(membershipId, organization.getId(), user.getId(), invite.getRole(), "active");
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("membership_exists", "User already belongs to this organization");
    }
    if (identities.markInviteAccepted(invite.getId(), user.getId()) == 0) {
      throw ApiException.conflict("invite_used", "Invite already accepted");
    }
    bind(user);
    agents.scheduleWakeFor(organization.getId(), user.getId());
    return identityService.me();
  }

  public User provisionUser(String username, String password, String displayName) {
    String normalized = AuthCredentials.requireUsername(username);
    Optional<User> existing = identities.findUserByUsername(normalized);
    if (existing.isPresent()) {
      return existing.get();
    }
    String name = AuthCredentials.requireDisplayName(
        Optional.ofNullable(displayName).filter(value -> !value.isBlank()).orElse(normalized));
    insertAccount(normalized, name, AuthCredentials.requirePassword(password), "user");
    return identities.findUserByUsername(normalized)
        .orElseThrow(() -> ApiException.conflict("user_create_failed", "Failed to create user"));
  }

  public void requireSuperAdmin() {
    if (!access.currentIdentity().superAdmin()) {
      throw new ApiException("permission_denied", "Super admin required", 403);
    }
  }

  public Identity identityOf(User user) {
    return toIdentity(user);
  }

  public MeResponse current() {
    return identityService.me();
  }

  private static Identity toIdentity(User user) {
    return new Identity(user.getId(), user.getUsername(), user.getDisplayName(), user.getPlatformRole());
  }

  private static ApiException invalidCredentials() {
    return new ApiException("invalid_credentials", "Invalid username or password", 401);
  }
}
