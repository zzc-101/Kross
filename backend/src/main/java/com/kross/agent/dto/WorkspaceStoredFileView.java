package com.kross.agent.dto;

public record WorkspaceStoredFileView(String path, long size, String mimeType, String name) {}
