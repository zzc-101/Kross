package com.kross.agent.dto;

import java.time.Instant;

public record WorkspaceStoredFileView(
    String path, long size, String mimeType, String name, String url, Instant urlExpiresAt) {
  public WorkspaceStoredFileView(String path, long size, String mimeType, String name) {
    this(path, size, mimeType, name, null, null);
  }
}
