package com.kross.work.dto;

import java.util.List;

public record CreateRunRequest(
    String taskId, String mode, List<String> selectedSourceIds, String requestedModelProfileId) {}
