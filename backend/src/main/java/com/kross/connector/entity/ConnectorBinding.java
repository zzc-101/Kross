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
public class ConnectorBinding {
  private String id;
  private String channel;
  private String tenantId;
  private String externalUserId;
  private String userId;
  private String organizationId;
  private Instant createdAt;
  private Instant updatedAt;
}
