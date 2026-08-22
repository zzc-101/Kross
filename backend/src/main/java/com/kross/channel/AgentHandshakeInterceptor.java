package com.kross.channel;

import com.kross.agent.AgentService;
import com.kross.api.ApiException;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
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
    String token = WebSocketTokens.credential(request);
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
}
