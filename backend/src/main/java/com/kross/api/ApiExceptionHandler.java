package com.kross.api;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {
  @ExceptionHandler(ApiException.class)
  public ResponseEntity<ApiErrorResponse> handleApi(ApiException error) {
    return ResponseEntity.status(error.getStatus()).body(error.toResponse());
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<ApiErrorResponse> handleValidation(MethodArgumentNotValidException error) {
    return handleApi(ApiException.invalidRequest("Request validation failed"));
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ResponseEntity<ApiErrorResponse> handleUnreadable() {
    return handleApi(new ApiException("invalid_json", "Request body must be a JSON object", 400));
  }

  @ExceptionHandler(MissingRequestHeaderException.class)
  public ResponseEntity<ApiErrorResponse> handleHeader(MissingRequestHeaderException error) {
    if ("x-kross-organization-id".equalsIgnoreCase(error.getHeaderName())) {
      return handleApi(new ApiException("organization_required", "x-kross-organization-id is required", 400));
    }
    return handleApi(ApiException.invalidRequest("Missing required header"));
  }

  @ExceptionHandler(AuthenticationException.class)
  public ResponseEntity<ApiErrorResponse> handleAuth(AuthenticationException error) {
    return handleApi(new ApiException("unauthenticated", error.getMessage(), 401));
  }

  @ExceptionHandler(AccessDeniedException.class)
  public ResponseEntity<ApiErrorResponse> handleDenied() {
    return handleApi(new ApiException("organization_access_denied", "Organization access denied", 403));
  }
}
