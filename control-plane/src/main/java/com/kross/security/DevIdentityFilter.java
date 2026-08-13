package com.kross.security;

import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
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
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class DevIdentityFilter extends OncePerRequestFilter {
  private final KrossProperties properties;
  private final IdentityMapper identities;

  public DevIdentityFilter(KrossProperties properties, IdentityMapper identities) {
    this.properties = properties;
    this.identities = identities;
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
    if (!properties.isDevIdentityEnabled()) {
      throw new ApiException("dev_identity_disabled", "Development identity is disabled", 401);
    }
    String userId = Optional.ofNullable(request.getHeader("x-kross-user-id")).orElse("");
    if (!Ids.isResourceId(userId)) {
      throw new ApiException("unauthenticated", "Missing development user identity", 401);
    }
    String displayName = Optional.ofNullable(request.getHeader("x-kross-user-name"))
        .map(String::trim)
        .filter(value -> !value.isBlank())
        .orElse(userId);
    identities.upsertUser(userId, displayName);
    Identity identity = new Identity(userId, displayName);
    UsernamePasswordAuthenticationToken authentication =
        new UsernamePasswordAuthenticationToken(identity, null, List.of());
    SecurityContextHolder.getContext().setAuthentication(authentication);
    filterChain.doFilter(request, response);
  }
}
