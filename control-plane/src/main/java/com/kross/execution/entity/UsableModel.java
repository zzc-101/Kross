package com.kross.execution.entity;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class UsableModel {
  private String id;
  private String provider;
  private String model;
  private String credentialHandleId;
}
