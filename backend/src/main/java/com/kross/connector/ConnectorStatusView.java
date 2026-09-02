package com.kross.connector;

import java.time.Instant;

public record ConnectorStatusView(String channel, boolean enabled, boolean bound, Instant boundAt) {}
