package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.kross.agent.dto.AgentProtocol;
import com.kross.api.ApiException;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;

class WorkerPayloadValidatorTest {
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void rejectsTooManyStreamEvents() {
    AgentProtocol.StreamEvent event = new AgentProtocol.StreamEvent(
        "text-delta", "x", null, null, null, null, null);

    assertThatThrownBy(() -> WorkerPayloadValidator.validateEvents(
        mapper, Collections.nCopies(101, event)))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("Too many");
  }

  @Test
  void rejectsOversizedStreamText() {
    AgentProtocol.StreamEvent event = new AgentProtocol.StreamEvent(
        "text-delta", "x".repeat(32_001), null, null, null, null, null);

    assertThatThrownBy(() -> WorkerPayloadValidator.validateEvents(mapper, List.of(event)))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("text");
  }

  @Test
  void acceptsBoundedStreamEvents() {
    AgentProtocol.StreamEvent event = new AgentProtocol.StreamEvent(
        "text-delta", "hello", null, null, null, null, null);

    assertThat(WorkerPayloadValidator.validateEvents(mapper, List.of(event))).containsExactly(event);
  }

  @Test
  void rejectsDerivedReplyContentBeyondLimit() {
    assertThatThrownBy(() -> WorkerPayloadValidator.validateContent("x".repeat(64_001)))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("Reply content");
  }

  @Test
  void extractsUniquePendingApprovalIds() {
    ArrayNode parts = mapper.createArrayNode();
    parts.addObject()
        .put("type", "tool")
        .put("status", "approval-required")
        .putObject("approval")
        .put("id", "run-1");
    parts.add(parts.get(0).deepCopy());

    assertThat(WorkerPayloadValidator.pendingApprovalIds(parts)).containsExactly("run-1");
  }

  @Test
  void rejectsPendingApprovalWithoutId() {
    ArrayNode parts = mapper.createArrayNode();
    parts.addObject().put("status", "approval-required");

    assertThatThrownBy(() -> WorkerPayloadValidator.pendingApprovalIds(parts))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("Approval id");
  }
}
