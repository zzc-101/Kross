package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class WorkspaceObjectKeysTest {
  @Test
  void stagingKeysStayUnderTheAgentPrefix() {
    String key = WorkspaceObjectKeys.stagingKey("org-1", "agent-1");
    assertThat(key).startsWith("workspaces/org-1/agent-1/.staging/");
    assertThat(WorkspaceObjectKeys.isStagingKey("org-1", "agent-1", key)).isTrue();
    assertThat(WorkspaceObjectKeys.isStagingKey("org-2", "agent-1", key)).isFalse();
    assertThat(WorkspaceObjectKeys.isStagingKey("org-1", "agent-1", "workspaces/org-1/agent-1/notes.txt")).isFalse();
    assertThat(WorkspaceObjectKeys.objectKey("org-1", "agent-1", "uploads/a.png"))
        .isEqualTo("workspaces/org-1/agent-1/uploads/a.png");
  }
}
