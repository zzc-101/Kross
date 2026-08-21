package com.kross.identity;

import com.kross.api.PageResponse;
import com.kross.identity.dto.AuthLoginEventView;
import com.kross.identity.entity.AuthLoginEvent;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

@Slf4j
@Service
@RequiredArgsConstructor
public class AuthLogService {
  private static final int MAX_USERNAME = 128;
  private static final int MAX_REASON = 64;
  private static final int MAX_IP = 64;
  private static final int MAX_USER_AGENT = 512;

  private final AuthLogMapper events;
  private final AuthService auth;

  public void record(
      HttpServletRequest request,
      String eventType,
      String method,
      String outcome,
      Optional<String> username,
      Optional<String> userId,
      Optional<String> reason) {
    AuthLoginEvent row = new AuthLoginEvent();
    row.setEventType(eventType);
    row.setMethod(method);
    row.setOutcome(outcome);
    row.setUsername(clip(username, MAX_USERNAME));
    row.setUserId(userId.filter(value -> !value.isBlank()).orElse(null));
    row.setReason(clip(reason, MAX_REASON));
    row.setIp(clip(Optional.ofNullable(clientIp(request)), MAX_IP));
    row.setUserAgent(clip(Optional.ofNullable(request.getHeader("User-Agent")), MAX_USER_AGENT));
    try {
      events.insert(row);
    } catch (RuntimeException error) {
      log.warn("Failed to persist auth event {}: {}", eventType, error.getMessage());
    }
  }

  public PageResponse<AuthLoginEventView> list(int page, int pageSize, Optional<String> eventType, Optional<String> outcome) {
    auth.requireSuperAdmin();
    int size = Math.min(Math.max(pageSize, 1), 100);
    int offset = (Math.max(page, 1) - 1) * size;
    List<AuthLoginEvent> rows = events.list(
        eventType.filter(value -> !value.isBlank()).orElse(null),
        outcome.filter(value -> !value.isBlank()).orElse(null),
        size,
        offset);
    int total = rows.isEmpty() ? 0 : Optional.ofNullable(rows.getFirst().getTotal()).orElse(0);
    return new PageResponse<>(
        rows.stream().map(AuthLogService::view).toList(),
        Math.max(page, 1),
        size,
        total);
  }

  private static AuthLoginEventView view(AuthLoginEvent row) {
    return new AuthLoginEventView(
        row.getId(),
        row.getEventType(),
        row.getMethod(),
        row.getOutcome(),
        row.getUsername(),
        row.getUserId(),
        row.getReason(),
        row.getIp(),
        row.getUserAgent(),
        row.getOccurredAt());
  }

  private static String clientIp(HttpServletRequest request) {
    return Optional.ofNullable(request.getHeader("X-Forwarded-For"))
        .map(value -> value.split(",")[0].trim())
        .filter(value -> !value.isBlank())
        .orElseGet(request::getRemoteAddr);
  }

  private static String clip(Optional<String> value, int max) {
    return value.map(String::trim).filter(text -> !text.isEmpty()).map(text -> {
      if (text.length() <= max) {
        return text;
      }
      return text.substring(0, max);
    }).orElse(null);
  }
}
