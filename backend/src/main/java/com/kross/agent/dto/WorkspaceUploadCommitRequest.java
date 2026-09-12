package com.kross.agent.dto;

public record WorkspaceUploadCommitRequest(
    String key, String directory, String name, String mimeType, long size) {}
