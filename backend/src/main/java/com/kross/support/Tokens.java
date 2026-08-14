package com.kross.support;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;

public final class Tokens {
  private static final SecureRandom RANDOM = new SecureRandom();

  private Tokens() {}

  public static String randomSecret() {
    byte[] secret = new byte[32];
    RANDOM.nextBytes(secret);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
  }

  public static String sha256Hex(String value) {
    return HexFormat.of().formatHex(sha256(value.getBytes(StandardCharsets.UTF_8)));
  }

  public static boolean hashEquals(String left, String right) {
    try {
      byte[] leftBytes = HexFormat.of().parseHex(Optional.ofNullable(left).orElse(""));
      byte[] rightBytes = HexFormat.of().parseHex(Optional.ofNullable(right).orElse(""));
      return leftBytes.length == rightBytes.length && MessageDigest.isEqual(leftBytes, rightBytes);
    } catch (IllegalArgumentException error) {
      return false;
    }
  }

  private static byte[] sha256(byte[] value) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(value);
    } catch (GeneralSecurityException error) {
      throw new IllegalStateException(error);
    }
  }
}
