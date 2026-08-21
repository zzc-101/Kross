package com.kross.identity.dto;

import java.util.List;

public record PlatformSsoView(
    boolean enabled,
    String displayName,
    String issuer,
    String clientId,
    boolean clientSecretConfigured,
    String redirectUri,
    List<String> additionalRedirectUris) {}
