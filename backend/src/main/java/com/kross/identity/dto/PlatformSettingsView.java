package com.kross.identity.dto;

public record PlatformSettingsView(
    boolean registrationEnabled, boolean knowledgeEnabled, boolean knowledgeAvailable) {}
