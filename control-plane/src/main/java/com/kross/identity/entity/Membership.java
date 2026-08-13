package com.kross.identity.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import java.time.Instant;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class Membership {
  private String id;
  private String organizationId;
  private String userId;
  private String role;
  private String status;
  private Instant createdAt;
  private Instant updatedAt;
}
