package com.kross.work.dto;

import com.fasterxml.jackson.databind.JsonNode;

public record CreateProjectRequest(String kind, String name, String description, JsonNode repository, String defaultTaskType) {}
