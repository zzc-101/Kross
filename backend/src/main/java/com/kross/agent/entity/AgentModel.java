package com.kross.agent.entity;

import com.fasterxml.jackson.databind.JsonNode;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class AgentModel {
  private String id;
  private String name;
  private String provider;
  private String model;
  private String secretCiphertext;
  private JsonNode configuration;
}
