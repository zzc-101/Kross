package com.kross.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.kross.config.KrossProperties;
import com.kross.identity.AuthService;
import com.kross.identity.Identity;
import com.kross.identity.IdentityMapper;
import com.kross.identity.entity.User;
import java.util.Optional;
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
    IdentityMapper identities = mock(IdentityMapper.class);
    User current = user("user-1", "super_admin", "active");
    when(identities.findUserById("user-1")).thenReturn(Optional.of(current));
    IdentityFilter filter = filter(identities);
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
    IdentityMapper identities = mock(IdentityMapper.class);
    when(identities.findUserById("user-1")).thenReturn(Optional.of(user("user-1", "user", "disabled")));
    IdentityFilter filter = filter(identities);
    MockHttpServletRequest request = requestWithIdentity(
        new Identity("user-1", "alice", "Alice", "user"));

    filter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

    assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    assertThat(request.getSession(false)).isNull();
  }

  @Test
  void doesNotTrustSecurityContextWithoutKrossIdentitySession() throws Exception {
    IdentityMapper identities = mock(IdentityMapper.class);
    IdentityFilter filter = filter(identities);
    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v2/me");
    SecurityContextHolder.getContext().setAuthentication(
        new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
            new Identity("user-1", "alice", "Alice", "super_admin"), null));

    filter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

    assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
  }

  private static IdentityFilter filter(IdentityMapper identities) {
    return new IdentityFilter(
        new KrossProperties(),
        mock(AuthService.class),
        identities,
        mock(Environment.class));
  }

  private static MockHttpServletRequest requestWithIdentity(Identity identity) {
    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v2/me");
    AuthSessions.establish(request, identity);
    return request;
  }

  private static User user(String id, String role, String status) {
    User user = new User();
    user.setId(id);
    user.setUsername("alice");
    user.setDisplayName("Alice");
    user.setPlatformRole(role);
    user.setStatus(status);
    return user;
  }
}
