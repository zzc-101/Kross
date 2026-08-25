package com.kross.identity;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.kross.api.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;

class AuthLogServiceTest {
  @Test
  void rejectsPasswordLoginAfterRecentFailureLimit() {
    AuthLogMapper events = mock(AuthLogMapper.class);
    HttpServletRequest request = mock(HttpServletRequest.class);
    when(request.getHeader("X-Real-IP")).thenReturn("203.0.113.8");
    when(events.countRecentPasswordFailures(eq("alice"), eq("203.0.113.8"), any()))
        .thenReturn(10);
    AuthLogService service = new AuthLogService(events, mock(AuthService.class));

    assertThatThrownBy(() -> service.requirePasswordLoginAllowed(request, "alice"))
        .isInstanceOf(ApiException.class)
        .extracting(error -> ((ApiException) error).getCode())
        .isEqualTo("login_rate_limited");
  }
}
