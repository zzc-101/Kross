package com.kross.identity;

import com.kross.api.ApiException;
import java.util.Optional;
import java.util.regex.Pattern;

public final class AuthCredentials {
  private static final Pattern USERNAME = Pattern.compile("^[A-Za-z][A-Za-z0-9_-]{2,31}$");
  private static final int MIN_PASSWORD = 8;
  private static final int MAX_PASSWORD = 128;
  private static final int MAX_DISPLAY_NAME = 64;

  private AuthCredentials() {}

  public static String requireUsername(String raw) {
    String username = Optional.ofNullable(raw).map(String::trim).map(String::toLowerCase).orElse("");
    if (!USERNAME.matcher(username).matches()) {
      throw ApiException.invalidRequest("Username must be 3-32 letters, digits, underscores or hyphens");
    }
    return username;
  }

  public static String requirePassword(String raw) {
    String password = Optional.ofNullable(raw).orElse("");
    if (password.length() < MIN_PASSWORD || password.length() > MAX_PASSWORD) {
      throw ApiException.invalidRequest("Password must be 8-128 characters");
    }
    return password;
  }

  public static String requireDisplayName(String raw) {
    String name = Optional.ofNullable(raw).map(String::trim).filter(value -> !value.isBlank()).orElse("");
    if (name.isEmpty() || name.length() > MAX_DISPLAY_NAME) {
      throw ApiException.invalidRequest("Display name is required");
    }
    return name;
  }
}
