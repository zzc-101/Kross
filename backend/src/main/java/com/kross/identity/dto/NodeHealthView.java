package com.kross.identity.dto;

import java.time.Instant;

public record NodeHealthView(
    String id,
    String hostname,
    String status,
    int runningAgents,
    boolean juicefsOk,
    Instant lastSeenAt,
    boolean connected) {}
