package com.kross.connector.feishu;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class FeishuCryptoTest {
  @Test
  void signMatchesSha256OfTimestampNonceKeyAndBody() {
    byte[] body = "{\"challenge\":\"abc\"}".getBytes(StandardCharsets.UTF_8);
    String signature = FeishuCrypto.sign("1710000000", "nonce-1", "encrypt-key", body);

    assertThat(signature).hasSize(64);
    assertThat(FeishuCrypto.verify("1710000000", "nonce-1", "encrypt-key", body, signature)).isTrue();
    assertThat(FeishuCrypto.verify("1710000000", "nonce-1", "encrypt-key", body, "sha256=" + signature)).isTrue();
    assertThat(FeishuCrypto.verify("1710000000", "other", "encrypt-key", body, signature)).isFalse();
  }

  @Test
  void decryptRoundTrip() throws Exception {
    String key = "test-encrypt-key";
    String plain = "{\"schema\":\"2.0\"}";
    String encrypt = encrypt(key, plain);

    assertThat(FeishuCrypto.decrypt(key, encrypt)).isEqualTo(plain);
  }

  private static String encrypt(String encryptKey, String plain) throws Exception {
    byte[] key = java.security.MessageDigest.getInstance("SHA-256")
        .digest(encryptKey.getBytes(StandardCharsets.UTF_8));
    byte[] iv = "1234567890abcdef".getBytes(StandardCharsets.UTF_8);
    int pad = 16 - (plain.getBytes(StandardCharsets.UTF_8).length % 16);
    byte[] padded = new byte[plain.getBytes(StandardCharsets.UTF_8).length + pad];
    System.arraycopy(plain.getBytes(StandardCharsets.UTF_8), 0, padded, 0, plain.getBytes(StandardCharsets.UTF_8).length);
    java.util.Arrays.fill(padded, plain.getBytes(StandardCharsets.UTF_8).length, padded.length, (byte) pad);
    javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/CBC/NOPADDING");
    cipher.init(
        javax.crypto.Cipher.ENCRYPT_MODE,
        new javax.crypto.spec.SecretKeySpec(key, "AES"),
        new javax.crypto.spec.IvParameterSpec(iv));
    byte[] ciphertext = cipher.doFinal(padded);
    byte[] packed = new byte[iv.length + ciphertext.length];
    System.arraycopy(iv, 0, packed, 0, iv.length);
    System.arraycopy(ciphertext, 0, packed, iv.length, ciphertext.length);
    return java.util.Base64.getEncoder().encodeToString(packed);
  }
}
