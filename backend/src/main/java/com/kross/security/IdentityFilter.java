package com.kross.security;

import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
import com.kross.identity.AuthCredentials;
import com.kross.identity.AuthService;
import com.kross.identity.Identity;
import com.kross.identity.IdentityMapper;
import com.kross.support.Ids;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Optional;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class IdentityFilter extends OncePerRequestFilter {
  private final KrossProperties properties;
  private final AuthService auth;
  private final IdentityMapper identities;
  private final Environment environment;

  public IdentityFilter(
      KrossProperties properties,
      AuthService auth,
      IdentityMapper identities,
      Environment environment) {
    this.properties = properties;
    this.auth = auth;
    this.identities = identities;
    this.environment = environment;
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    String path = request.getRequestURI();
    return path.equals("/health") || path.startsWith("/internal/");
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
    SecurityContextHolder.clearContext();
    Optional<Identity> identity = currentIdentity(request).or(() -> developmentIdentity(request));
    identity.ifPresent(value -> SecurityContextHolder.getContext().setAuthentication(
        new UsernamePasswordAuthenticationToken(value, null, List.of())));
    filterChain.doFilter(request, response);
  }

  private Optional<Identity> currentIdentity(HttpServletRequest request) {
    Optional<Identity> stored = AuthSessions.current(request);
    if (stored.isEmpty()) {
      return Optional.empty();
    }
    Optional<Identity> current = identities.findUserById(stored.get().userId())
        .filter(user -> "active".equals(user.getStatus()))
        .map(user -> new Identity(
            user.getId(), user.getUsername(), user.getDisplayName(), user.getPlatformRole()));
    if (current.isEmpty()) {
      AuthSessions.clear(request);
      return Optional.empty();
    }
    if (!current.get().equals(stored.get())) {
      AuthSessions.refresh(request, current.get());
    }
    return current;
  }

  private Optional<Identity> developmentIdentity(HttpServletRequest request) {
    if (!properties.isDevIdentityEnabled()
        || !environment.acceptsProfiles(Profiles.of("dev"))) {
      return Optional.empty();
    }
    String userId = Optional.ofNullable(request.getHeader("x-kross-user-id")).orElse("");
    if (!Ids.isResourceId(userId)) {
      return Optional.empty();
    }
    String displayName = Optional.ofNullable(request.getHeader("x-kross-user-name"))
        .map(String::trim)
        .filter(value -> !value.isBlank())
        .orElse(userId);
    try {
      String username = AuthCredentials.requireUsername(userId);
      return Optional.of(auth.authenticate(userId, username, displayName));
    } catch (ApiException ignored) {
      return Optional.of(auth.authenticate(userId, userId.toLowerCase(), displayName));
    }
  }
}
