package com.kross.identity.dto;

public record UpdateProfileRequest(String displayName, String avatarUrl, String gender, String phone) {}
