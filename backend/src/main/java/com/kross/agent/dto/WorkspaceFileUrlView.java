package com.kross.agent.dto;

import java.time.Instant;

public record WorkspaceFileUrlView(
    String path, String url, Instant expiresAt, String mimeType, String name, boolean inline) {}
