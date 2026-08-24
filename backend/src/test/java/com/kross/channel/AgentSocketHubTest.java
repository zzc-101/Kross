package com.kross.channel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.AgentService;
import com.kross.agent.dto.AgentProtocol;
import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

class AgentSocketHubTest {
  @Test
  void doesNotHoldSocketLockWhileClaimingDatabaseJob() throws Exception {
    AgentService agents = mock(AgentService.class);
    WebSocketSession session = mock(WebSocketSession.class);
    when(session.getId()).thenReturn("session-1");
    when(session.isOpen()).thenReturn(true);
    CountDownLatch claiming = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    doAnswer(invocation -> {
      claiming.countDown();
      release.await(2, TimeUnit.SECONDS);
      return Optional.empty();
    }).when(agents).claimIfIdle("token-1");
    AgentSocketHub hub = new AgentSocketHub(new ObjectMapper().findAndRegisterModules(), agents);
    hub.attach("agent-1", "token-1", session);

    Thread offer = Thread.ofVirtual().start(() -> hub.offerJob("agent-1"));
    assertThat(claiming.await(1, TimeUnit.SECONDS)).isTrue();

    hub.sendRequired("agent-1", java.util.Map.of("type", "test"));

    verify(session).sendMessage(any());
    release.countDown();
    offer.join();
  }

  @Test
  void releasesClaimWhenWebSocketDeliveryFails() throws Exception {
    AgentService agents = mock(AgentService.class);
    WebSocketSession session = mock(WebSocketSession.class);
    when(session.getId()).thenReturn("session-1");
    when(session.isOpen()).thenReturn(true);
    AgentProtocol.Job job = new AgentProtocol.Job(
        "message-1",
        "conversation-1",
        "reply-1",
        "hello",
        List.of(),
        Instant.now(),
        "agent",
        "model-1",
        "lease-1",
        null);
    when(agents.claimIfIdle("token-1")).thenReturn(Optional.of(job));
    doThrow(new IOException("send failed")).when(session).sendMessage(any());
    AgentSocketHub hub = new AgentSocketHub(new ObjectMapper().findAndRegisterModules(), agents);
    hub.attach("agent-1", "token-1", session);

    hub.offerJob("agent-1");

    verify(agents).releaseClaimedJob("agent-1", "message-1", "lease-1");
  }
}
