package com.kross.identity;

import com.kross.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

public final class AuthCredentials {
  private static final Pattern USERNAME = Pattern.compile("^[A-Za-z][A-Za-z0-9_-]{2,31}$");
  private static final int MIN_PASSWORD = 8;
  private static final int MAX_PASSWORD = 128;
  private static final int MAX_DISPLAY_NAME = 64;

  private static final Pattern PHONE = Pattern.compile("^\\+?[0-9]{6,15}$");
  private static final int MAX_AVATAR_URL = 2048;

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

  static String requireBcryptPassword(String raw) {
    String password = requirePassword(raw);
    if (password.getBytes(StandardCharsets.UTF_8).length > 72) {
      throw ApiException.invalidRequest("Password must not exceed 72 UTF-8 bytes");
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

  public static Optional<String> optionalEmail(String raw) {
    String email = Optional.ofNullable(raw).map(String::trim).map(String::toLowerCase).orElse("");
    if (email.isEmpty()) {
      return Optional.empty();
    }
    int at = email.indexOf('@');
    if (at < 1 || at != email.lastIndexOf('@') || at == email.length() - 1 || email.length() > 254) {
      return Optional.empty();
    }
    return Optional.of(email);
  }

  public static Optional<String> optionalPhone(String raw) {
    String phone = Optional.ofNullable(raw).map(String::trim).map(value -> value.replaceAll("\\s+", "")).orElse("");
    if (phone.isEmpty()) {
      return Optional.empty();
    }
    if (!PHONE.matcher(phone).matches()) {
      throw ApiException.invalidRequest("Phone must be 6-15 digits, optionally starting with +");
    }
    return Optional.of(phone);
  }

  public static Optional<String> optionalAvatarUrl(String raw, boolean requiredIfPresent) {
    String url = Optional.ofNullable(raw).map(String::trim).orElse("");
    if (url.isEmpty()) {
      return Optional.empty();
    }
    boolean http = url.startsWith("https://") || url.startsWith("http://");
    if (!http || url.length() > MAX_AVATAR_URL) {
      if (!requiredIfPresent) {
        return Optional.empty();
      }
      throw ApiException.invalidRequest("Avatar URL must be an http(s) URL");
    }
    return Optional.of(url);
  }

  public static Optional<String> optionalGender(String raw) {
    String gender = Optional.ofNullable(raw).map(String::trim).map(String::toLowerCase).orElse("");
    if (gender.isEmpty()) {
      return Optional.empty();
    }
    if (!Set.of("unspecified", "male", "female", "other").contains(gender)) {
      throw ApiException.invalidRequest("Gender is invalid");
    }
    return Optional.of(gender);
  }

  public static String usernameFromClaims(String preferredUsername, String email, String subject) {
    return tryUsername(preferredUsername)
        .or(() -> tryUsername(Optional.ofNullable(email).map(value -> value.split("@")[0]).orElse("")))
        .orElseGet(() -> fallbackUsername(subject));
  }

  public static Optional<String> tryUsername(String raw) {
    String username = Optional.ofNullable(raw).map(String::trim).map(String::toLowerCase)
        .map(value -> value.replaceAll("[^a-z0-9_-]", ""))
        .orElse("");
    if (username.isEmpty()) {
      return Optional.empty();
    }
    if (!Character.isLetter(username.charAt(0))) {
      username = "u" + username;
    }
    if (username.length() > 32) {
      username = username.substring(0, 32);
    }
    if (!USERNAME.matcher(username).matches()) {
      return Optional.empty();
    }
    return Optional.of(username);
  }

  private static String fallbackUsername(String subject) {
    String compact = Optional.ofNullable(subject).orElse("user").replaceAll("[^a-zA-Z0-9]", "").toLowerCase();
    if (compact.length() < 2) {
      compact = "user" + Integer.toHexString(Math.abs(Optional.ofNullable(subject).orElse("x").hashCode()));
    }
    String username = "u" + compact;
    return username.length() <= 32 ? username : username.substring(0, 32);
  }
}
