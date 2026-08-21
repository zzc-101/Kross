package com.kross.identity.entity;

import java.time.Instant;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
public class User {
  private String id;
  private String username;
  private String displayName;
  private String passwordHash;
  private String platformRole;
  private String status;
  private String email;
  private String ssoIssuer;
  private String ssoSubject;
  private Instant createdAt;
}
