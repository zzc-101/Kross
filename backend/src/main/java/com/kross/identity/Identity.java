package com.kross.identity;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.io.Serial;
import java.io.Serializable;

public record Identity(String userId, String username, String displayName, String platformRole)
    implements Serializable {
  @Serial
  private static final long serialVersionUID = 1L;

  @JsonIgnore
  public boolean superAdmin() {
    return "super_admin".equals(platformRole);
  }
}
