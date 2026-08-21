package com.kross.observability;

import com.kross.api.ApiHeaders;
import com.kross.identity.Identity;
import com.kross.security.AuthSessions;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Slf4j
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class RequestLogFilter extends OncePerRequestFilter {
  private static final Pattern CONVERSATION = Pattern.compile("/agent/conversations/([^/]+)");

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return "/health".equals(request.getRequestURI());
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
    bind(request);
    try {
      filterChain.doFilter(request, response);
    } finally {
      log.info("{} {} {}", request.getMethod(), request.getRequestURI(), response.getStatus());
      MDC.clear();
    }
  }

  private static void bind(HttpServletRequest request) {
    RequestLogContext.put(
        RequestLogContext.ORGANIZATION_ID,
        request.getHeader(ApiHeaders.ORGANIZATION_ID));
    AuthSessions.identity(request).map(Identity::userId)
        .ifPresent(userId -> RequestLogContext.put(RequestLogContext.USER_ID, userId));
    conversationId(request.getRequestURI())
        .ifPresent(id -> RequestLogContext.put(RequestLogContext.CONVERSATION_ID, id));
    RequestLogContext.put(RequestLogContext.NODE_ID, request.getParameter("nodeId"));
  }

  private static Optional<String> conversationId(String path) {
    return Optional.ofNullable(path)
        .map(CONVERSATION::matcher)
        .filter(Matcher::find)
        .map(matcher -> matcher.group(1))
        .filter(value -> !value.isBlank());
  }
}
