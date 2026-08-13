package com.kross.api;

import com.fasterxml.jackson.databind.JsonNode;

public record ApiError(String code, String message, JsonNode details) {
  public ApiError(String code, String message) {
    this(code, message, null);
  }
}
