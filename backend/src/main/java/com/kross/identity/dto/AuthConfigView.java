package com.kross.identity.dto;

public record AuthConfigView(
    boolean registrationEnabled,
    boolean bootstrapRequired,
    boolean organizationExists,
    boolean ssoEnabled,
    String ssoDisplayName) {}
