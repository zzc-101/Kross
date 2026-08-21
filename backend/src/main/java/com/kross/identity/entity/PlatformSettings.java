package com.kross.identity.entity;

import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
public class PlatformSettings {
  private Boolean registrationEnabled;
  private Boolean ssoEnabled;
  private String ssoDisplayName;
  private String ssoIssuer;
  private String ssoClientId;
  private String ssoClientSecretCipher;
}
