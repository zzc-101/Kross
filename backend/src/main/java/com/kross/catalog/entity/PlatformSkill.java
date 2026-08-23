package com.kross.catalog.entity;

import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class PlatformSkill {
  private String id;
  private String name;
  private String description;
  private String category;
  private String icon;
  private String launchMode;
  private String starterPrompt;
  private String activeVersionId;
  private String content;
  private String contentDigest;
  private long revision;
  private long latestVersion;
  private Integer versionCount;
  private String packageSha256;
  private Long packageSizeBytes;
  private String status;
  private String createdBy;
  private Instant createdAt;
  private Instant updatedAt;
  private Integer installCount;
  private Boolean installed;
  private Instant installedAt;
}
