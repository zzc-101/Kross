package com.kross.work.dto;

import java.util.List;

public record CreateTaskRequest(String projectId, String type, String title, String objective, List<String> constraints, List<String> acceptanceCriteria) {}
