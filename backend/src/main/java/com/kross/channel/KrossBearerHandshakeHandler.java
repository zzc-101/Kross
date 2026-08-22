package com.kross.channel;

import java.util.List;
import java.util.Optional;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;

public class KrossBearerHandshakeHandler extends DefaultHandshakeHandler {
  @Override
  protected String selectProtocol(List<String> requestedProtocols, WebSocketHandler webSocketHandler) {
    return Optional.ofNullable(requestedProtocols).orElse(List.of()).stream()
        .map(String::trim)
        .filter(value -> value.startsWith(WebSocketTokens.BEARER_PROTOCOL_PREFIX))
        .filter(value -> value.length() > WebSocketTokens.BEARER_PROTOCOL_PREFIX.length())
        .findFirst()
        .orElse(null);
  }
}
