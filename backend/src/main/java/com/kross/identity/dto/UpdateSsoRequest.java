package com.kross.identity.dto;

public record UpdateSsoRequest(
    Boolean enabled,
    String displayName,
    String issuer,
    String clientId,
    String clientSecret) {}
