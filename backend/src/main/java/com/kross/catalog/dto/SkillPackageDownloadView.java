package com.kross.catalog.dto;

import java.time.Instant;

public record SkillPackageDownloadView(String url, Instant expiresAt) {}
