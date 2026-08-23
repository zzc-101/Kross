package com.kross.catalog.dto;

public record UpdateSkillRequest(
    String name,
    String description,
    String category,
    String icon,
    String launchMode,
    String starterPrompt,
    String content,
    String status) {}
