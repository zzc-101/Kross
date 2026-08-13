package com.kross.execution.entity;

import com.fasterxml.jackson.databind.JsonNode;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class QueuedLaunch {
  private JsonNode resourceLimits;
  private JsonNode permissionPolicy;
}
