package com.kross.worker.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class WorkerProtocol {
  private WorkerProtocol() {}

  public static String messageId() {
    return UUID.randomUUID().toString();
  }

  public record IssuedRunToken(String token, String expiresAt) {}

  public record WorkerRegisterRequest(
      String type,
      String workerId,
      String runId,
      int generation,
      String leaseId) {}

  public record WorkerHeartbeatRequest(
      String type,
      String workerSessionId,
      String runId,
      int generation,
      String leaseId) {}

  public record WorkerReleaseRequest(
      String type,
      String workerSessionId,
      String runId,
      int generation,
      String leaseId,
      String reason) {}

  public record WorkerEventRequest(String type, EventEnvelope envelope) {}

  public record EventEnvelope(
      int protocolVersion,
      String runId,
      int generation,
      long seq,
      Instant timestamp,
      JsonNode event) {}

  public record ArtifactReserveRequest(
      String type,
      String idempotencyKey,
      String runId,
      int generation,
      String taskId,
      String kind,
      String displayName,
      String mimeType,
      long sizeBytes,
      String sha256,
      String parentArtifactId,
      List<String> sourceIds) {}

  public record ArtifactCommitRequest(
      String type,
      String idempotencyKey,
      String runId,
      int generation,
      String artifactId,
      long sizeBytes,
      String sha256,
      String uploadEtag) {}

  public record WorkerRegistered(
      int protocolVersion,
      String type,
      String messageId,
      Instant sentAt,
      String workerSessionId,
      int heartbeatIntervalMs,
      RunSpec runSpec) {}

  public record WorkerEventAck(
      int protocolVersion,
      String type,
      String messageId,
      Instant sentAt,
      String runId,
      int generation,
      long acceptedThroughSeq) {}

  public record LeaseRenewed(
      int protocolVersion,
      String type,
      String messageId,
      Instant sentAt,
      String workerSessionId,
      String runId,
      int generation,
      String leaseId,
      Instant leaseExpiresAt) {}

  public record ApprovalDecision(
      int protocolVersion,
      String type,
      String messageId,
      Instant sentAt,
      String decisionId,
      String runId,
      int generation,
      String approvalId,
      String decision,
      String reason,
      Instant decidedAt,
      String requestHash) {}

  public record ArtifactReserved(
      int protocolVersion,
      String type,
      String messageId,
      Instant sentAt,
      String idempotencyKey,
      String runId,
      int generation,
      String artifactId,
      boolean alreadyCommitted,
      ArtifactUpload upload) {}

  public record ArtifactUpload(
      String method,
      String url,
      List<Header> headers,
      Instant expiresAt) {}

  public record Header(String name, String value) {}

  public record ArtifactCommitted(
      int protocolVersion,
      String type,
      String messageId,
      Instant sentAt,
      String idempotencyKey,
      String runId,
      int generation,
      CommittedArtifact artifact) {}

  public record CommittedArtifact(
      String id,
      String organizationId,
      String projectId,
      String taskId,
      String kind,
      String status,
      String displayName,
      String mimeType,
      long sizeBytes,
      String sha256,
      List<String> sourceIds,
      boolean previewAvailable,
      String downloadPath,
      Instant readyAt,
      Instant createdAt,
      String parentArtifactId) {}

  public record CheckpointStored(String checkpointKey) {}

  public record ModelEnvironment(Map<String, String> env) {}

  public record RunSpec(
      int protocolVersion,
      String organizationId,
      String projectId,
      String taskId,
      String runId,
      int generation,
      String leaseId,
      Instant leaseExpiresAt,
      Instant issuedAt,
      RunSpecTask task,
      List<RunSpecSource> sources,
      JsonNode repository,
      JsonNode model,
      String mode,
      String executionProfile,
      RunSpecPolicy policy,
      JsonNode resourceLimits,
      RunSpecWorkspace workspace,
      String resumeCheckpointKey) {}

  public record RunSpecTask(
      String type,
      String title,
      String objective,
      List<String> constraints,
      List<String> acceptanceCriteria,
      List<RunSpecMessage> messages) {}

  public record RunSpecMessage(String id, String role, String text, Instant createdAt) {}

  public record RunSpecSource(
      String id,
      String kind,
      String displayName,
      String fileName,
      String mimeType,
      long sizeBytes,
      String sha256,
      String downloadUrl,
      List<Header> downloadHeaders,
      Instant expiresAt) {}

  public record RunSpecPolicy(
      JsonNode permissionPolicy,
      List<String> allowedToolNames,
      List<String> connectorInstallationIds,
      String externalActions,
      String networkAccess) {}

  public record RunSpecWorkspace(
      String root,
      String inputDirectory,
      String outputDirectory,
      String checkpointDirectory,
      String repositoryDirectory) {}
}
