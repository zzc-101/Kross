package com.kross.identity.entity;

import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class OrganizationInvite {
  private String id;
  private String organizationId;
  private String tokenHash;
  private String role;
  private String createdBy;
  private Instant expiresAt;
  private Instant acceptedAt;
  private String acceptedBy;
  private Instant createdAt;
}
