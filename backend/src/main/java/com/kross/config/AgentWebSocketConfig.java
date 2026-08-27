package com.kross.config;

import com.kross.channel.AgentHandshakeInterceptor;
import com.kross.channel.AgentWebSocketHandler;
import com.kross.channel.KrossBearerHandshakeHandler;
import lombok.RequiredArgsConstructor;
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

  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry.addHandler(handler, "/internal/v2/agents/ws")
        .addInterceptors(handshake)
        .setHandshakeHandler(new KrossBearerHandshakeHandler())
        .setAllowedOriginPatterns("*");
  }

  @Bean
  public ServletServerContainerFactoryBean agentWebSocketContainer() {
    ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
    container.setMaxTextMessageBufferSize(1024 * 1024);
    container.setMaxBinaryMessageBufferSize(64 * 1024);
    container.setMaxSessionIdleTimeout(0L);
    return container;
  }
}
