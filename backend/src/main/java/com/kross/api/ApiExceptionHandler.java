package com.kross.api;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
@Slf4j
public class ApiExceptionHandler {
  @ExceptionHandler(ApiException.class)
  public ResponseEntity<Res<Void>> handleApi(ApiException error) {
    return ResponseEntity.status(error.getStatus()).body(Res.fail(error.getStatus(), error.getMessage()));
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<Res<Void>> handleValidation(MethodArgumentNotValidException error) {
    return handleApi(ApiException.invalidRequest("Request validation failed"));
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ResponseEntity<Res<Void>> handleUnreadable() {
    return handleApi(new ApiException("invalid_json", "Request body must be a JSON object", 400));
  }

  @ExceptionHandler(MissingRequestHeaderException.class)
  public ResponseEntity<Res<Void>> handleHeader(MissingRequestHeaderException error) {
    if ("x-kross-organization-id".equalsIgnoreCase(error.getHeaderName())) {
      return handleApi(new ApiException("organization_required", "x-kross-organization-id is required", 400));
    }
    return handleApi(ApiException.invalidRequest("Missing required header"));
  }

  @ExceptionHandler(AuthenticationException.class)
  public ResponseEntity<Res<Void>> handleAuth(AuthenticationException error) {
    return handleApi(new ApiException("unauthenticated", error.getMessage(), 401));
  }

  @ExceptionHandler(AccessDeniedException.class)
  public ResponseEntity<Res<Void>> handleDenied() {
    return handleApi(new ApiException("organization_access_denied", "Organization access denied", 403));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<Res<Void>> handleUnexpected(Exception error) {
    log.error("Unhandled API exception", error);
    return ResponseEntity.internalServerError().body(Res.fail(500, "Internal server error"));
  }
}
