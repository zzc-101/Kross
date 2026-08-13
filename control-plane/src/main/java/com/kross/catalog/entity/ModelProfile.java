package com.kross.catalog.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class ModelProfile {
  private String id;
  private String organizationId;
  private String name;
  private String provider;
  private String model;
  private String credentialHandleId;
  private JsonNode configuration;
  private String status;
  private String createdBy;
  private Instant createdAt;
  private Instant updatedAt;
  private Integer total;
}
