package com.kross.identity.entity;

import java.time.Instant;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
public class OrganizationListRow {
  private String id;
  private String slug;
  private String name;
  private String status;
  private Integer adminCount;
  private Integer memberCount;
  private Instant createdAt;
  private Integer total;
}
