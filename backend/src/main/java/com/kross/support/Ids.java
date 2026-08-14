package com.kross.support;

import java.util.Optional;
import java.util.regex.Pattern;

public final class Ids {
  private static final Pattern RESOURCE_ID = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
  private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
  private static final Pattern SLUG = Pattern.compile("^[a-z0-9][a-z0-9-]{1,62}$");
  private static final Pattern HANDLE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$");
  private static final Pattern MIME = Pattern.compile("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+");

  private Ids() {}

  public static String requireResourceId(String value, String message) {
    return require(RESOURCE_ID, Optional.ofNullable(value).orElse(""), message);
  }

  public static boolean isResourceId(String value) {
    return value != null && RESOURCE_ID.matcher(value).matches();
  }

  public static String requireSlug(String value) {
    return require(SLUG, Optional.ofNullable(value).orElse(""), "Invalid organization slug");
  }

  public static String requireSha256(String value) {
    return require(SHA256, Optional.ofNullable(value).orElse(""), "Invalid sha256");
  }

  public static String requireHandle(String value) {
    return require(HANDLE, Optional.ofNullable(value).orElse(""), "Invalid credential handle");
  }

  public static String normalizeMime(String value) {
    String normalized = Optional.ofNullable(value).orElse("").split(";", 2)[0].trim().toLowerCase();
    return require(MIME, normalized, "Invalid MIME type");
  }

  private static String require(Pattern pattern, String value, String message) {
    if (!pattern.matcher(value).matches()) {
      throw new com.kross.api.ApiException("invalid_request", message, 400);
    }
    return value;
  }
}
