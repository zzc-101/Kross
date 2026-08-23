package com.kross.catalog.entity;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class PlatformSkillVersion {
  private String id;
  private String skillId;
  private long version;
  private String packageKey;
  private String packageSha256;
  private long packageSizeBytes;
  private String skillMd;
  private String skillMdDigest;
  private JsonNode manifest;
  private String changelog;
  private String createdBy;
  private Instant createdAt;
  private Instant publishedAt;
  private Boolean active;
}

