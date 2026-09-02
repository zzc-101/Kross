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
public class ConnectorThread {
  private String id;
  private String channel;
  private String externalChatId;
  private String conversationId;
  private String bindingId;
  private Instant createdAt;
  private Instant updatedAt;
}
