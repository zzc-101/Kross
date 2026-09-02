package com.kross.connector;

import java.time.Instant;

public record ConnectorBindCodeView(String channel, String code, Instant expiresAt) {}
