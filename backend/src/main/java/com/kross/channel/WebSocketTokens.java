package com.kross.channel;

import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.ServerHttpRequest;

public final class WebSocketTokens {
  public static final String BEARER_PROTOCOL_PREFIX = "kross.bearer.";

  private WebSocketTokens() {}

  public static String credential(ServerHttpRequest request) {
    String header = bearer(request);
    if (!header.isBlank()) {
      return header;
    }
    return bearerProtocol(request);
  }

  public static String bearer(ServerHttpRequest request) {
    String header = Optional.ofNullable(request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION)).orElse("");
    if (!header.startsWith("Bearer ") || header.length() <= 7) {
      return "";
    }
    return header.substring("Bearer ".length()).trim();
  }

  public static String bearerProtocol(ServerHttpRequest request) {
    return Optional.ofNullable(request.getHeaders().get("Sec-WebSocket-Protocol")).orElse(List.of()).stream()
        .flatMap(header -> Arrays.stream(header.split(",")))
        .map(String::trim)
        .filter(value -> value.startsWith(BEARER_PROTOCOL_PREFIX))
        .map(value -> value.substring(BEARER_PROTOCOL_PREFIX.length()))
        .filter(value -> !value.isBlank())
        .findFirst()
        .orElse("");
  }
}
