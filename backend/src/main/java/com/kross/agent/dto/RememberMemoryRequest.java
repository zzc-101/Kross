package com.kross.agent.dto;

public record RememberMemoryRequest(String conversationId, String messageId, String content, String kind) {}
