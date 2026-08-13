package com.kross.work.dto;

public record CompleteSourceRequest(long sizeBytes, String sha256, String mimeType) {}
