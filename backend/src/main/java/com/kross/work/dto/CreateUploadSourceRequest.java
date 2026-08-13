package com.kross.work.dto;

public record CreateUploadSourceRequest(String scope, String taskId, String displayName, String previousSourceId, String mimeType, Long sizeBytes, String sha256) {}
