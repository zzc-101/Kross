package com.kross.work.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.execution.entity.Run;
import com.kross.work.entity.Artifact;
import com.kross.work.entity.Project;
import com.kross.work.entity.Source;
import com.kross.work.entity.Task;
import com.kross.work.entity.TaskMessage;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public final class WorkViews {
  private WorkViews() {}

  public static ProjectView project(Project row) {
    return new ProjectView(
        row.getId(),
        row.getOrganizationId(),
        row.getKind(),
        row.getName(),
        row.getDescription(),
        row.getStatus(),
        row.getCreatedBy(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  public static TaskView task(Task row) {
    return new TaskView(
        row.getId(),
        row.getOrganizationId(),
        row.getProjectId(),
        row.getType(),
        row.getTitle(),
        row.getObjective(),
        stringList(row.getConstraints()),
        stringList(row.getAcceptanceCriteria()),
        row.getStatus(),
        row.getLatestRunId(),
        row.getCreatedBy(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  public static TaskMessageView message(TaskMessage row) {
    return new TaskMessageView(
        row.getId(),
        row.getOrganizationId(),
        row.getProjectId(),
        row.getTaskId(),
        row.getRunId(),
        row.getRole(),
        row.getContent(),
        row.getCreatedBy(),
        row.getCreatedAt());
  }

  public static SourceView source(Source row) {
    return new SourceView(
        row.getId(),
        row.getOrganizationId(),
        row.getProjectId(),
        row.getTaskId(),
        row.getKind(),
        row.getScope(),
        row.getStatus(),
        row.getDisplayName(),
        row.getMimeType(),
        row.getSizeBytes(),
        row.getSha256(),
        row.getBlobKey(),
        row.getExternalLocator(),
        row.getOrigin(),
        row.getPreviousSourceId(),
        row.getMetadata(),
        row.getCreatedBy(),
        row.getCreatedAt());
  }

  public static SourceUploadView sourceUpload(Source row, UploadInstruction upload) {
    SourceView source = source(row);
    return new SourceUploadView(
        source.id(),
        source.organizationId(),
        source.projectId(),
        source.taskId(),
        source.kind(),
        source.scope(),
        source.status(),
        source.displayName(),
        source.mimeType(),
        source.sizeBytes(),
        source.sha256(),
        source.blobKey(),
        source.externalLocator(),
        source.origin(),
        source.previousSourceId(),
        source.metadata(),
        source.createdBy(),
        source.createdAt(),
        upload);
  }

  public static ArtifactView artifact(Artifact row) {
    return new ArtifactView(
        row.getId(),
        row.getOrganizationId(),
        row.getProjectId(),
        row.getTaskId(),
        row.getRunId(),
        row.getKind(),
        row.getStatus(),
        row.getDisplayName(),
        row.getFileName(),
        row.getMimeType(),
        row.getSizeBytes(),
        row.getSha256(),
        row.getBlobKey(),
        row.getPreviousArtifactId(),
        row.getMetadata(),
        row.getGeneration(),
        row.getCreatedAt(),
        row.getReadyAt());
  }

  public static RunView run(Run row) {
    return new RunView(
        row.getId(),
        row.getOrganizationId(),
        row.getProjectId(),
        row.getTaskId(),
        row.getAttempt(),
        row.getStatus(),
        row.getMode(),
        row.getQueuedAt(),
        row.getStartedAt(),
        row.getFinishedAt(),
        row.getCreatedBy());
  }

  private static List<String> stringList(JsonNode node) {
    if (node == null || !node.isArray()) {
      return List.of();
    }
    List<String> values = new ArrayList<>();
    node.forEach(item -> values.add(item.asText()));
    return List.copyOf(values);
  }

  public static Optional<String> text(String value) {
    return Optional.ofNullable(value).map(String::trim).filter(item -> !item.isBlank());
  }
}
