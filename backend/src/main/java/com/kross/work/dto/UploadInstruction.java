package com.kross.work.dto;

import java.time.Instant;
import java.util.List;

public record UploadInstruction(String method, String url, List<UploadHeader> headers, Instant expiresAt) {}
