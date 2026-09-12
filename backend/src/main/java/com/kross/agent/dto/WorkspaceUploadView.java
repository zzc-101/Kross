package com.kross.agent.dto;

import java.time.Instant;

public record WorkspaceUploadView(String key, String method, String url, Instant expiresAt, String mimeType) {}
