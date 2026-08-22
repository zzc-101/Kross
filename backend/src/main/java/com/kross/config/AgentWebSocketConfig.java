package com.kross.config;

import com.kross.channel.AgentHandshakeInterceptor;
import com.kross.channel.AgentWebSocketHandler;
import com.kross.channel.KrossBearerHandshakeHandler;
import com.kross.fleet.NodeHandshakeInterceptor;
import com.kross.fleet.NodeWebSocketHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
@RequiredArgsConstructor
public class AgentWebSocketConfig implements WebSocketConfigurer {
  private final AgentWebSocketHandler handler;
  private final AgentHandshakeInterceptor handshake;
  private final ObjectProvider<NodeWebSocketHandler> nodeHandler;
  private final ObjectProvider<NodeHandshakeInterceptor> nodeHandshake;

  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry.addHandler(handler, "/internal/v2/agents/ws")
        .addInterceptors(handshake)
        .setHandshakeHandler(new KrossBearerHandshakeHandler())
        .setAllowedOriginPatterns("*");
    NodeWebSocketHandler nodes = nodeHandler.getIfAvailable();
    NodeHandshakeInterceptor nodeAuth = nodeHandshake.getIfAvailable();
    if (nodes != null && nodeAuth != null) {
      registry.addHandler(nodes, "/internal/v2/nodes/ws")
          .addInterceptors(nodeAuth)
          .setAllowedOriginPatterns("*");
    }
  }

  @Bean
  public ServletServerContainerFactoryBean agentWebSocketContainer() {
    ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
    container.setMaxTextMessageBufferSize(2 * 1024 * 1024);
    container.setMaxBinaryMessageBufferSize(64 * 1024);
    container.setMaxSessionIdleTimeout(0L);
    return container;
  }
}
