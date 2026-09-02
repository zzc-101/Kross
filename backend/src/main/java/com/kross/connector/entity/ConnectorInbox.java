package com.kross.connector.entity;

import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class ConnectorInbox {
  private String id;
  private String channel;
  private String eventId;
  private String payload;
  private String status;
  private int attempts;
  private String lastError;
  private Instant nextAttemptAt;
  private Instant createdAt;
  private Instant updatedAt;
}
