package com.kross.identity.entity;

import java.time.Instant;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
public class AuthLoginEvent {
  private String id;
  private String eventType;
  private String method;
  private String outcome;
  private String username;
  private String userId;
  private String reason;
  private String ip;
  private String userAgent;
  private Instant occurredAt;
  private Integer total;
}
