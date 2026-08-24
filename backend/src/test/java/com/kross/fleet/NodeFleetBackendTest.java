package com.kross.fleet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.kross.agent.AgentMapper;
import com.kross.agent.entity.Agent;
import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
import com.kross.orchestrator.ContainerBackend;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class NodeFleetBackendTest {
  @Test
  void refusesFailoverWhenPreviousNodeCannotBeFenced() {
    NodeHub hub = mock(NodeHub.class);
    AgentMapper agents = mock(AgentMapper.class);
    Agent agent = new Agent();
    agent.setId("agent-1");
    agent.setNodeId("node-old");
    when(agents.findByIdOnly("agent-1")).thenReturn(Optional.of(agent));
    when(hub.isHealthy("node-old", false)).thenReturn(false);
    when(hub.pickLeastLoaded(false)).thenReturn(Optional.of("node-new"));
    when(hub.isOnline("node-old")).thenReturn(false);
    NodeFleetBackend backend = new NodeFleetBackend(hub, agents, new KrossProperties());

    ApiException error = catchThrowableOfType(
        ApiException.class,
        () -> backend.start(new ContainerBackend.StartRequest(
            "agent-1", "token", "http://control", new ContainerBackend.ResourceLimits(1000, 1024, 64))));

    assertThat(error.getCode()).isEqualTo("agent_fencing_required");
    verify(hub, never()).request(org.mockito.ArgumentMatchers.eq("node-new"), any());
  }
}
