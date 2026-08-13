package com.kross.api;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Optional;

public class ApiException extends RuntimeException {
  private final String code;
  private final int status;
  private final JsonNode details;

  public ApiException(String code, String message, int status) {
    this(code, message, status, null);
  }

  public ApiException(String code, String message, int status, JsonNode details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }

  public static ApiException notFound(String resource) {
    return new ApiException("not_found", resource + " not found", 404);
  }

  public static ApiException conflict(String code, String message) {
    return new ApiException(code, message, 409);
  }

  public static ApiException invalidRequest(String message) {
    return new ApiException("invalid_request", message, 400);
  }

  public String getCode() {
    return code;
  }

  public int getStatus() {
    return status;
  }

  public Optional<JsonNode> getDetails() {
    return Optional.ofNullable(details);
  }

  public ApiErrorResponse toResponse() {
    return new ApiErrorResponse(new ApiError(code, getMessage(), details));
  }
}
