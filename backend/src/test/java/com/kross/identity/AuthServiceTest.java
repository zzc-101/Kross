package com.kross.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.kross.agent.AgentService;
import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
import com.kross.identity.dto.LoginRequest;
import com.kross.identity.entity.User;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.password.PasswordEncoder;

class AuthServiceTest {
  private IdentityMapper identities;
  private PasswordEncoder passwords;
  private AuthService service;

  @BeforeEach
  void setUp() {
    identities = mock(IdentityMapper.class);
    passwords = mock(PasswordEncoder.class);
    when(passwords.encode("kross-dummy-password-not-valid")).thenReturn("dummy-hash");
    service = new AuthService(
        identities,
        mock(IdentityService.class),
        mock(OrganizationAccess.class),
        passwords,
        mock(AgentService.class),
        mock(KrossProperties.class));
  }

  @Test
  void performsPasswordCheckForUnknownUsername() {
    when(identities.findUserByUsername("missing")).thenReturn(Optional.empty());
    when(passwords.matches("password", "dummy-hash")).thenReturn(false);

    ApiException error = catchThrowableOfType(
        ApiException.class,
        () -> service.login(new LoginRequest("missing", "password")));

    assertThat(error.getCode()).isEqualTo("invalid_credentials");
    verify(passwords).matches("password", "dummy-hash");
  }

  @Test
  void doesNotRevealDisabledStatusBeforePasswordIsVerified() {
    User disabled = new User();
    disabled.setId("user-1");
    disabled.setUsername("alice");
    disabled.setPasswordHash("real-hash");
    disabled.setPlatformRole("user");
    disabled.setStatus("disabled");
    when(identities.findUserByUsername("alice")).thenReturn(Optional.of(disabled));
    when(passwords.matches("wrong-pass", "real-hash")).thenReturn(false);

    ApiException error = catchThrowableOfType(
        ApiException.class,
        () -> service.login(new LoginRequest("alice", "wrong-pass")));

    assertThat(error.getCode()).isEqualTo("invalid_credentials");
  }
}
