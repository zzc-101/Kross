package com.kross.channel;

import com.kross.agent.AgentService;
import com.kross.api.ApiException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Component
@RequiredArgsConstructor
public class AgentHandshakeInterceptor implements HandshakeInterceptor {
  private final AgentService agents;

  @Override
  public boolean beforeHandshake(
      ServerHttpRequest request,
      ServerHttpResponse response,
      WebSocketHandler wsHandler,
      Map<String, Object> attributes) {
    String token = bearer(request);
    if (token.isBlank()) {
      token = queryValue(request.getURI(), "token");
    }
    try {
      var session = agents.requireAgentSession(token);
      attributes.put(AgentSocketHub.ATTR_TOKEN, token);
      attributes.put(AgentSocketHub.ATTR_AGENT_ID, session.getAgentId());
      return true;
    } catch (ApiException error) {
      response.setStatusCode(HttpStatus.UNAUTHORIZED);
      return false;
    }
  }

  @Override
  public void afterHandshake(
      ServerHttpRequest request,
      ServerHttpResponse response,
      WebSocketHandler wsHandler,
      Exception exception) {
    // token is stored on the session during the handshake
  }

  private static String bearer(ServerHttpRequest request) {
    String header = Optional.ofNullable(request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION)).orElse("");
    if (!header.startsWith("Bearer ") || header.length() <= 7) {
      return "";
    }
    return header.substring("Bearer ".length());
  }

  private static String queryValue(URI uri, String name) {
    String query = Optional.ofNullable(uri.getRawQuery()).orElse("");
    for (String pair : query.split("&")) {
      int eq = pair.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      String key = URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8);
      if (name.equals(key)) {
        return URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
      }
    }
    return "";
  }
}
