package com.kross.agent.entity;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class AgentSettings {
  private String agentId;
  private String organizationId;
  private JsonNode mcpServers;
  private Instant updatedAt;
}
