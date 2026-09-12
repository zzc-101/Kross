package com.kross.agent.dto;

import java.util.List;
import java.util.Optional;

public record AppendAgentMessageRequest(String content, List<WorkspaceFileRef> files) {
  public AppendAgentMessageRequest(String content) {
    this(content, List.of());
  }

  public AppendAgentMessageRequest {
    files = Optional.ofNullable(files).orElseGet(List::of);
  }
}
