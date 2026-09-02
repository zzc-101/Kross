package com.kross.connector;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.kross.api.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

class ConnectorBindCodesTest {
  @Test
  void issueWritesSixDigitCode() {
    StringRedisTemplate redis = mock(StringRedisTemplate.class);
    @SuppressWarnings("unchecked")
    ValueOperations<String, String> values = mock(ValueOperations.class);
    when(redis.opsForValue()).thenReturn(values);
    when(values.setIfAbsent(any(), eq("user-1 org-1"), eq(ConnectorBindCodes.TTL))).thenReturn(true);
    ConnectorBindCodes codes = new ConnectorBindCodes(provider(redis));

    String code = codes.issue("feishu", "user-1", "org-1");

    assertThat(code).matches("\\d{6}");
    verify(values).setIfAbsent(eq("app:bind:feishu:" + code), eq("user-1 org-1"), eq(ConnectorBindCodes.TTL));
  }

  @Test
  void consumeDeletesCode() {
    StringRedisTemplate redis = mock(StringRedisTemplate.class);
    @SuppressWarnings("unchecked")
    ValueOperations<String, String> values = mock(ValueOperations.class);
    when(redis.opsForValue()).thenReturn(values);
    when(values.getAndDelete("app:bind:feishu:123456")).thenReturn("user-1 org-1");
    ConnectorBindCodes codes = new ConnectorBindCodes(provider(redis));

    assertThat(codes.consume("feishu", "123456"))
        .contains(new ConnectorBindCodes.BindingTarget("user-1", "org-1"));
  }

  @Test
  void issueFailsWithoutRedis() {
    ConnectorBindCodes codes = new ConnectorBindCodes(provider(null));
    assertThatThrownBy(() -> codes.issue("feishu", "user-1", "org-1"))
        .isInstanceOf(ApiException.class)
        .extracting(error -> ((ApiException) error).getStatus())
        .isEqualTo(503);
  }

  @SuppressWarnings("unchecked")
  private static <T> ObjectProvider<T> provider(T value) {
    ObjectProvider<T> objectProvider = mock(ObjectProvider.class);
    when(objectProvider.getIfAvailable()).thenReturn(value);
    return objectProvider;
  }
}
