package com.kross.work.dto;

public record CreateInlineSourceRequest(String scope, String taskId, String displayName, String previousSourceId, String mimeType, String content) {}
