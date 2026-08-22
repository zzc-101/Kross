package com.kross.fleet;

import com.kross.channel.WebSocketTokens;
import com.kross.config.KrossProperties;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "kross.worker-runtime", havingValue = "cluster")
public class NodeHandshakeInterceptor implements HandshakeInterceptor {
  private final KrossProperties properties;

  @Override
  public boolean beforeHandshake(
      ServerHttpRequest request,
      ServerHttpResponse response,
      WebSocketHandler wsHandler,
      Map<String, Object> attributes) {
    String nodeId = queryValue(request.getURI(), "nodeId");
    if (nodeId.isBlank()) {
      response.setStatusCode(HttpStatus.BAD_REQUEST);
      return false;
    }
    String expected = properties.tokenForNode(nodeId).orElse("");
    String token = WebSocketTokens.bearer(request);
    if (expected.isBlank() || !tokenEquals(expected, token)) {
      response.setStatusCode(HttpStatus.UNAUTHORIZED);
      return false;
    }
    attributes.put(NodeHub.ATTR_NODE_ID, nodeId);
    return true;
  }

  @Override
  public void afterHandshake(
      ServerHttpRequest request,
      ServerHttpResponse response,
      WebSocketHandler wsHandler,
      Exception exception) {
    // node id is stored on the session during the handshake
  }

  private static boolean tokenEquals(String expected, String actual) {
    byte[] left = expected.getBytes(StandardCharsets.UTF_8);
    byte[] right = Optional.ofNullable(actual).orElse("").getBytes(StandardCharsets.UTF_8);
    return MessageDigest.isEqual(left, right);
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
