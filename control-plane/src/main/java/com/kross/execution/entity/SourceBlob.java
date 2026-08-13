package com.kross.execution.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class SourceBlob {
  private String id;
  private String kind;
  private String displayName;
  private String mimeType;
  private Long sizeBytes;
  private String sha256;
  private String blobKey;
}
