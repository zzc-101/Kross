package com.kross.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.kross.config.KrossProperties;
import com.kross.identity.AuthService;
import com.kross.identity.Identity;
import com.kross.identity.IdentityDirectory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.env.Environment;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;

class IdentityFilterTest {
  @AfterEach
  void clearSecurityContext() {
    SecurityContextHolder.clearContext();
  }

  @Test
  void refreshesPlatformRoleFromDatabaseOnEveryRequest() throws Exception {
    IdentityDirectory directory = mock(IdentityDirectory.class);
    IdentityDirectory.CachedUser current =
        new IdentityDirectory.CachedUser("user-1", "alice", "Alice", "super_admin", "active");
    when(directory.findUser("user-1")).thenReturn(current);
    IdentityFilter filter = filter(directory);
    MockHttpServletRequest request = requestWithIdentity(
        new Identity("user-1", "alice", "Alice", "user"));

    filter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

    assertThat(SecurityContextHolder.getContext().getAuthentication().getPrincipal())
        .isEqualTo(new Identity("user-1", "alice", "Alice", "super_admin"));
    assertThat(AuthSessions.current(request))
        .contains(new Identity("user-1", "alice", "Alice", "super_admin"));
  }

  @Test
  void invalidatesSessionWhenAccountIsDisabled() throws Exception {
    IdentityDirectory directory = mock(IdentityDirectory.class);
    when(directory.findUser("user-1"))
        .thenReturn(new IdentityDirectory.CachedUser("user-1", "alice", "Alice", "user", "disabled"));
    IdentityFilter filter = filter(directory);
    MockHttpServletRequest request = requestWithIdentity(
        new Identity("user-1", "alice", "Alice", "user"));

    filter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

    assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    assertThat(request.getSession(false)).isNull();
  }

  @Test
  void doesNotTrustSecurityContextWithoutKrossIdentitySession() throws Exception {
    IdentityFilter filter = filter(mock(IdentityDirectory.class));
    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v2/me");
    SecurityContextHolder.getContext().setAuthentication(
        new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
            new Identity("user-1", "alice", "Alice", "super_admin"), null));

    filter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

    assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
  }

  private static IdentityFilter filter(IdentityDirectory directory) {
    return new IdentityFilter(
        new KrossProperties(),
        mock(AuthService.class),
        directory,
        mock(Environment.class));
  }

  private static MockHttpServletRequest requestWithIdentity(Identity identity) {
    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v2/me");
    AuthSessions.establish(request, identity);
    return request;
  }
}
