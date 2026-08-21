package com.kross.security;

import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
import com.kross.identity.AuthCredentials;
import com.kross.identity.AuthService;
import com.kross.identity.Identity;
import com.kross.support.Ids;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Optional;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class IdentityFilter extends OncePerRequestFilter {
  private final KrossProperties properties;
  private final AuthService auth;

  public IdentityFilter(KrossProperties properties, AuthService auth) {
    this.properties = properties;
    this.auth = auth;
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
    if (SecurityContextHolder.getContext().getAuthentication() == null
        || !(SecurityContextHolder.getContext().getAuthentication().getPrincipal() instanceof Identity)) {
      AuthSessions.current(request)
          .or(() -> developmentIdentity(request))
          .ifPresent(identity -> SecurityContextHolder.getContext().setAuthentication(
              new UsernamePasswordAuthenticationToken(identity, null, List.of())));
    }
    filterChain.doFilter(request, response);
  }

  private Optional<Identity> developmentIdentity(HttpServletRequest request) {
    if (!properties.isDevIdentityEnabled()) {
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
