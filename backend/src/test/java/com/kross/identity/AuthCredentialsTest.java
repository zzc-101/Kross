package com.kross.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kross.api.ApiException;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class AuthCredentialsTest {
  @Test
  void acceptsNewPasswordAtBcryptByteLimit() {
    String password = "密".repeat(24);

    assertThat(password.getBytes(StandardCharsets.UTF_8)).hasSize(72);
    assertThat(AuthCredentials.requireBcryptPassword(password)).isEqualTo(password);
  }

  @Test
  void rejectsNewPasswordBeyondBcryptByteLimit() {
    String password = "密".repeat(25);

    assertThatThrownBy(() -> AuthCredentials.requireBcryptPassword(password))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("72 UTF-8 bytes");
  }
}
