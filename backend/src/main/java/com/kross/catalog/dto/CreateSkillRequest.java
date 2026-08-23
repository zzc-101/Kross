package com.kross.catalog.dto;

public record CreateSkillRequest(
    String id,
    String name,
    String description,
    String category,
    String icon,
    String launchMode,
    String starterPrompt,
    String changelog) {}
