package com.kross.security;

import com.kross.identity.Identity;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import java.util.List;
import java.util.Optional;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;

public final class AuthSessions {
  static final String IDENTITY_ATTR = "kross.identity";

  private AuthSessions() {}

  public static void establish(HttpServletRequest request, Identity identity) {
    Optional.ofNullable(request.getSession(false)).ifPresent(HttpSession::invalidate);
    HttpSession session = request.getSession(true);
    session.setAttribute(IDENTITY_ATTR, identity);
    UsernamePasswordAuthenticationToken authentication =
        new UsernamePasswordAuthenticationToken(identity, null, List.of());
    SecurityContext context = SecurityContextHolder.createEmptyContext();
    context.setAuthentication(authentication);
    SecurityContextHolder.setContext(context);
    session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, context);
  }

  public static void refresh(HttpServletRequest request, Identity identity) {
    HttpSession session = Optional.ofNullable(request.getSession(false)).orElseGet(() -> request.getSession(true));
    session.setAttribute(IDENTITY_ATTR, identity);
    UsernamePasswordAuthenticationToken authentication =
        new UsernamePasswordAuthenticationToken(identity, null, List.of());
    SecurityContext context = SecurityContextHolder.createEmptyContext();
    context.setAuthentication(authentication);
    SecurityContextHolder.setContext(context);
    session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, context);
  }

  public static void clear(HttpServletRequest request) {
    SecurityContextHolder.clearContext();
    Optional.ofNullable(request.getSession(false)).ifPresent(HttpSession::invalidate);
  }

  static Optional<Identity> current(HttpServletRequest request) {
    return Optional.ofNullable(request.getSession(false))
        .map(session -> session.getAttribute(IDENTITY_ATTR))
        .filter(Identity.class::isInstance)
        .map(Identity.class::cast);
  }
}
