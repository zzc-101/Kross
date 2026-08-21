package com.kross.identity.dto;

public record UserProfileView(
    String userId,
    String username,
    String displayName,
    String platformRole,
    String status,
    String email,
    String avatarUrl,
    String gender,
    String phone) {}
