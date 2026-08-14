package com.kross.identity;

import com.fasterxml.jackson.annotation.JsonValue;

public enum MembershipRole {
  OWNER("owner"),
  ADMIN("admin"),
  MEMBER("member"),
  VIEWER("viewer");

  private final String wire;

  MembershipRole(String wire) {
    this.wire = wire;
  }

  @JsonValue
  public String wire() {
    return wire;
  }

  public static MembershipRole fromWire(String wire) {
    for (MembershipRole role : values()) {
      if (role.wire.equals(wire)) {
        return role;
      }
    }
    throw new IllegalArgumentException("Unknown membership role: " + wire);
  }
}
