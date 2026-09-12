package com.kross.agent.dto;

public record WorkspaceUploadRequest(String directory, String name, String mimeType, long size) {}
