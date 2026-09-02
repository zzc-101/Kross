package com.kross.connector.feishu;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class FeishuCrypto {
  private FeishuCrypto() {}

  public static boolean verify(String timestamp, String nonce, String encryptKey, byte[] body, String signature) {
    String expected = sign(timestamp, nonce, encryptKey, body);
    String provided = Optional.ofNullable(signature).orElse("").trim();
    if (provided.startsWith("sha256=")) {
      provided = provided.substring("sha256=".length());
    }
    return !expected.isEmpty() && MessageDigest.isEqual(
        expected.getBytes(StandardCharsets.US_ASCII),
        provided.toLowerCase().getBytes(StandardCharsets.US_ASCII));
  }

  public static String sign(String timestamp, String nonce, String encryptKey, byte[] body) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      digest.update(Optional.ofNullable(timestamp).orElse("").getBytes(StandardCharsets.UTF_8));
      digest.update(Optional.ofNullable(nonce).orElse("").getBytes(StandardCharsets.UTF_8));
      digest.update(Optional.ofNullable(encryptKey).orElse("").getBytes(StandardCharsets.UTF_8));
      digest.update(body == null ? new byte[0] : body);
      return HexFormat.of().formatHex(digest.digest());
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("SHA-256 is required", error);
    }
  }

  public static String decrypt(String encryptKey, String encrypt) {
    try {
      byte[] key = MessageDigest.getInstance("SHA-256").digest(encryptKey.getBytes(StandardCharsets.UTF_8));
      byte[] decode = Base64.getDecoder().decode(encrypt);
      if (decode.length < 17) {
        throw new GeneralSecurityException("ciphertext too short");
      }
      Cipher cipher = Cipher.getInstance("AES/CBC/NOPADDING");
      cipher.init(
          Cipher.DECRYPT_MODE,
          new SecretKeySpec(key, "AES"),
          new IvParameterSpec(Arrays.copyOfRange(decode, 0, 16)));
      byte[] decrypted = cipher.doFinal(Arrays.copyOfRange(decode, 16, decode.length));
      int pad = decrypted[decrypted.length - 1] & 0xff;
      if (pad <= 0 || pad > 16 || pad > decrypted.length) {
        throw new GeneralSecurityException("invalid padding");
      }
      return new String(decrypted, 0, decrypted.length - pad, StandardCharsets.UTF_8);
    } catch (GeneralSecurityException | IllegalArgumentException error) {
      throw new IllegalArgumentException("Unable to decrypt Feishu payload", error);
    }
  }
}
