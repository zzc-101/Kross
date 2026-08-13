package com.kross.worker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.kross.api.ApiException;
import com.kross.catalog.CredentialVault;
import com.kross.config.KrossProperties;
import com.kross.execution.ExecutionMapper;
import com.kross.execution.entity.Approval;
import com.kross.execution.entity.ModelCredential;
import com.kross.execution.entity.RunLease;
import com.kross.execution.entity.RunSpecData;
import com.kross.execution.entity.SourceBlob;
import com.kross.execution.entity.WorkerToken;
import com.kross.storage.ObjectStorage;
import com.kross.support.Ids;
import com.kross.support.Jsons;
import com.kross.work.WorkMapper;
import com.kross.work.entity.Artifact;
import com.kross.worker.dto.WorkerProtocol;
import com.kross.worker.dto.WorkerProtocol.ApprovalDecision;
import com.kross.worker.dto.WorkerProtocol.ArtifactCommitRequest;
import com.kross.worker.dto.WorkerProtocol.ArtifactCommitted;
import com.kross.worker.dto.WorkerProtocol.ArtifactReserveRequest;
import com.kross.worker.dto.WorkerProtocol.ArtifactReserved;
import com.kross.worker.dto.WorkerProtocol.ArtifactUpload;
import com.kross.worker.dto.WorkerProtocol.CheckpointStored;
import com.kross.worker.dto.WorkerProtocol.CommittedArtifact;
import com.kross.worker.dto.WorkerProtocol.EventEnvelope;
import com.kross.worker.dto.WorkerProtocol.Header;
import com.kross.worker.dto.WorkerProtocol.IssuedRunToken;
import com.kross.worker.dto.WorkerProtocol.LeaseRenewed;
import com.kross.worker.dto.WorkerProtocol.ModelEnvironment;
import com.kross.worker.dto.WorkerProtocol.RunSpec;
import com.kross.worker.dto.WorkerProtocol.RunSpecMessage;
import com.kross.worker.dto.WorkerProtocol.RunSpecPolicy;
import com.kross.worker.dto.WorkerProtocol.RunSpecSource;
import com.kross.worker.dto.WorkerProtocol.RunSpecTask;
import com.kross.worker.dto.WorkerProtocol.RunSpecWorkspace;
import com.kross.worker.dto.WorkerProtocol.WorkerEventAck;
import com.kross.worker.dto.WorkerProtocol.WorkerHeartbeatRequest;
import com.kross.worker.dto.WorkerProtocol.WorkerRegisterRequest;
import com.kross.worker.dto.WorkerProtocol.WorkerRegistered;
import com.kross.worker.dto.WorkerProtocol.WorkerReleaseRequest;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class WorkerControlService {
  private static final long MAX_ARTIFACT_BYTES = 104_857_600L;
  private static final int MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

  private final ExecutionMapper execution;
  private final WorkMapper work;
  private final ObjectStorage storage;
  private final CredentialVault vault;
  private final KrossProperties properties;
  private final ObjectMapper mapper;
  private final SecureRandom random = new SecureRandom();

  public IssuedRunToken issueRunToken(RunLease lease, long ttlMs) {
    byte[] secret = new byte[32];
    random.nextBytes(secret);
    String token = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
    Instant requested = Instant.now().plusMillis(ttlMs);
    Instant expiresAt = requested.isBefore(lease.getExpiresAt()) ? requested : lease.getExpiresAt();
    if (!expiresAt.isAfter(Instant.now())) {
      throw ApiException.conflict("lease_expired", "Cannot issue a token for an expired lease");
    }
    if (execution.insertToken(
            hashToken(token),
            lease.getOrganizationId(),
            lease.getRunId(),
            lease.getGeneration(),
            lease.getLeaseId(),
            expiresAt)
        != 1) {
      throw ApiException.conflict("lease_lost", "Lease is no longer active");
    }
    return new IssuedRunToken(token, expiresAt.toString());
  }

  @Transactional
  public WorkerRegistered register(String token, WorkerRegisterRequest message) {
    WorkerToken binding = authenticate(token, false);
    assertBinding(binding, message.runId(), message.generation(), Optional.of(message.leaseId()), Optional.empty());
    if (binding.getWorkerId() != null && !binding.getWorkerId().equals(message.workerId())) {
      throw new ApiException("worker_token_mismatch", "Token is already bound to another Worker", 401);
    }
    String sessionId = Optional.ofNullable(binding.getWorkerSessionId())
        .filter(value -> !value.isBlank())
        .orElse(UUID.randomUUID().toString());
    if (execution.bindWorker(binding.getTokenHash(), sessionId, message.workerId()) != 1) {
      throw ApiException.conflict("worker_registration_conflict", "Worker registration raced or token was revoked");
    }
    return new WorkerRegistered(
        2,
        "worker.registered",
        WorkerProtocol.messageId(),
        Instant.now(),
        sessionId,
        (int) properties.getScheduler().getHeartbeatIntervalMs(),
        loadRunSpec(binding));
  }

  @Transactional
  public WorkerEventAck appendEvent(String token, EventEnvelope envelope) {
    WorkerToken binding = authenticate(token, true);
    assertBinding(binding, envelope.runId(), envelope.generation(), Optional.empty(), Optional.empty());
    JsonNode event = Optional.ofNullable(envelope.event())
        .orElseThrow(() -> ApiException.invalidRequest("Worker event payload is required"));
    String type = event.path("type").asText();
    Instant occurredAt = envelope.timestamp();
    int inserted = execution.insertEvent(
        UUID.randomUUID().toString(),
        binding.getOrganizationId(),
        binding.getRunId(),
        binding.getGeneration(),
        binding.getLeaseId(),
        envelope.seq(),
        type,
        occurredAt,
        event);
    if (inserted == 1 && "run.approval_requested".equals(type)) {
      insertApproval(binding, event);
    }
    if (inserted == 1) {
      execution.projectRunFromEvent(
          binding.getOrganizationId(),
          binding.getRunId(),
          type,
          occurredAt,
          event.path("terminal").path("status").asText(null));
    }
    long accepted = execution.maxEventSeq(binding.getRunId(), binding.getGeneration());
    if (accepted == 0) {
      throw ApiException.conflict("worker_event_rejected", "Run lease is no longer active");
    }
    return new WorkerEventAck(
        2, "worker.event_ack", WorkerProtocol.messageId(), Instant.now(),
        binding.getRunId(), binding.getGeneration(), accepted);
  }

  @Transactional
  public LeaseRenewed heartbeat(String token, WorkerHeartbeatRequest message) {
    WorkerToken binding = authenticate(token, true);
    assertBinding(
        binding,
        message.runId(),
        message.generation(),
        Optional.of(message.leaseId()),
        Optional.of(message.workerSessionId()));
    long durationMs = properties.getScheduler().getLeaseDurationMs();
    RunLease lease = execution.renewLease(
            binding.getOrganizationId(),
            binding.getLeaseId(),
            binding.getLeaseOwner(),
            binding.getGeneration(),
            durationMs)
        .orElseThrow(() -> ApiException.notFound("Lease"));
    execution.extendToken(binding.getTokenHash(), lease.getExpiresAt(), durationMs);
    return new LeaseRenewed(
        2, "lease.renewed", WorkerProtocol.messageId(), Instant.now(),
        message.workerSessionId(), binding.getRunId(), binding.getGeneration(),
        binding.getLeaseId(), lease.getExpiresAt());
  }

  @Transactional
  public void release(String token, WorkerReleaseRequest message) {
    WorkerToken binding = authenticate(token, true);
    assertBinding(
        binding,
        message.runId(),
        message.generation(),
        Optional.of(message.leaseId()),
        Optional.of(message.workerSessionId()));
    if (execution.workerReleaseLease(
            binding.getOrganizationId(),
            binding.getRunId(),
            binding.getLeaseId(),
            binding.getLeaseOwner(),
            binding.getGeneration())
        != 1) {
      throw ApiException.notFound("Lease");
    }
    execution.revokeToken(binding.getTokenHash());
  }

  @Transactional
  public ArtifactReserved reserveArtifact(String token, ArtifactReserveRequest message) {
    WorkerToken binding = authenticate(token, true);
    assertBinding(binding, message.runId(), message.generation(), Optional.empty(), Optional.empty());
    if (message.sizeBytes() < 0 || message.sizeBytes() > MAX_ARTIFACT_BYTES) {
      throw new ApiException("blob_too_large", "Blob exceeds its size limit", 413);
    }
    Optional<Artifact> existing = work.findArtifactByReserveKey(
        binding.getOrganizationId(), message.runId(), message.idempotencyKey());
    existing.ifPresent(row -> assertReservation(row, message));
    Artifact row = existing.orElseGet(() -> insertArtifact(binding, message));
    if ("ready".equals(row.getStatus())) {
      return reserved(message, row, true, Optional.empty());
    }
    if (!"pending".equals(row.getStatus())) {
      throw ApiException.conflict("artifact_not_pending", "Artifact cannot be uploaded in its current state");
    }
    Instant expiresAt = Instant.now().plus(properties.getS3().getPresignTtl());
    ObjectStorage.SignedUrl upload = storage.presignPut(
        row.getUploadBlobKey(), ObjectStorage.Audience.INTERNAL, row.getMimeType(), expiresAt);
    return reserved(
        message,
        row,
        false,
        Optional.of(new ArtifactUpload(
            upload.method(),
            upload.url(),
            List.of(new Header("content-type", row.getMimeType())),
            upload.expiresAt())));
  }

  @Transactional
  public ArtifactCommitted commitArtifact(String token, ArtifactCommitRequest message) {
    WorkerToken binding = authenticate(token, true);
    assertBinding(binding, message.runId(), message.generation(), Optional.empty(), Optional.empty());
    Artifact row = work.findArtifactForCommit(
            binding.getOrganizationId(), message.runId(), message.artifactId())
        .orElseThrow(() -> ApiException.notFound("Artifact"));
    if (!Objects.equals(row.getReserveIdempotencyKey(), message.idempotencyKey())
        || !Objects.equals(row.getGeneration(), message.generation())) {
      throw ApiException.conflict("artifact_commit_mismatch", "Artifact commit does not match its reservation");
    }
    if (!Objects.equals(row.getSizeBytes(), message.sizeBytes()) || !Objects.equals(row.getSha256(), message.sha256())) {
      throw new ApiException("artifact_content_mismatch", "Artifact content does not match its reservation", 422);
    }
    if ("ready".equals(row.getStatus())) {
      return committed(message, row);
    }
    if (!"pending".equals(row.getStatus())) {
      throw ApiException.conflict("artifact_not_pending", "Artifact cannot be committed in its current state");
    }
    String blobKey = storage.promote(row.getUploadBlobKey(), message.sha256(), message.sizeBytes());
    JsonNode existingMetadata = Jsons.objectOrEmpty(row.getMetadata()).deepCopy();
    ObjectNode metadata = existingMetadata instanceof ObjectNode object
        ? object
        : mapper.createObjectNode();
    Optional.ofNullable(message.uploadEtag())
        .map(String::trim)
        .filter(value -> !value.isBlank())
        .ifPresent(value -> metadata.put("uploadEtag", value));
    row.setBlobKey(blobKey);
    row.setMetadata(metadata);
    if (work.commitArtifact(row) != 1) {
      throw ApiException.conflict("artifact_commit_race", "Artifact commit raced");
    }
    Artifact ready = work.findArtifactForCommit(
            binding.getOrganizationId(), message.runId(), message.artifactId())
        .orElseThrow(() -> ApiException.notFound("Artifact"));
    return committed(message, ready);
  }

  @Transactional
  public Optional<ApprovalDecision> nextApprovalDecision(String token) {
    WorkerToken binding = authenticate(token, true);
    Optional<Approval> found = execution.nextWorkerApproval(
        binding.getOrganizationId(), binding.getRunId(), binding.getGeneration());
    if (found.isEmpty()) {
      return Optional.empty();
    }
    Approval row = found.get();
    String consumptionKey = "worker-generation-" + binding.getGeneration();
    if (execution.markApprovalDelivered(
            binding.getOrganizationId(), row.getId(), binding.getGeneration(), consumptionKey)
        != 1) {
      throw ApiException.conflict("approval_consumption_raced", "Approval consumption raced");
    }
    return Optional.of(new ApprovalDecision(
        2,
        "approval.decision",
        WorkerProtocol.messageId(),
        Instant.now(),
        Optional.ofNullable(row.getDecisionIdempotencyKey()).orElse(row.getId()),
        binding.getRunId(),
        binding.getGeneration(),
        row.getId(),
        row.getStatus(),
        row.getDecisionReason(),
        row.getDecidedAt(),
        row.getRequestHash()));
  }

  public CheckpointStored putCheckpoint(String token, String sha256, long sizeBytes, byte[] content) {
    WorkerToken binding = authenticate(token, true);
    Ids.requireSha256(sha256);
    if (sizeBytes < 0 || sizeBytes > MAX_CHECKPOINT_BYTES || content.length != sizeBytes) {
      throw new ApiException("invalid_checkpoint_metadata", "Invalid checkpoint metadata", 400);
    }
    String actual = HexFormat.of().formatHex(sha256(content));
    if (!actual.equals(sha256)) {
      throw new ApiException("blob_hash_mismatch", "Checkpoint hash does not match", 422);
    }
    String checkpointKey = "checkpoints/" + binding.getOrganizationId() + "/" + binding.getRunId() + "/" + sha256 + ".json";
    Optional<ObjectStorage.ObjectStat> existing = storage.head(checkpointKey);
    if (existing.isEmpty()) {
      storage.putBytes(checkpointKey, content, "application/json");
    } else if (existing.get().sizeBytes() != sizeBytes) {
      throw ApiException.conflict("checkpoint_blob_conflict", "Checkpoint blob metadata conflicts");
    }
    if (execution.setCheckpoint(binding.getOrganizationId(), binding.getRunId(), checkpointKey) != 1) {
      throw ApiException.conflict("checkpoint_run_state", "Run cannot accept a checkpoint");
    }
    return new CheckpointStored(checkpointKey);
  }

  public software.amazon.awssdk.core.ResponseInputStream<software.amazon.awssdk.services.s3.model.GetObjectResponse>
      getCheckpoint(String token, String checkpointKey) {
    WorkerToken binding = authenticate(token, true);
    execution.findCheckpoint(binding.getOrganizationId(), binding.getRunId(), checkpointKey)
        .orElseThrow(() -> ApiException.notFound("Checkpoint"));
    return storage.get(checkpointKey);
  }

  public ModelEnvironment mintModelEnvironment(String token) {
    WorkerToken binding = authenticate(token, false);
    ModelCredential credential = execution.findRunCredential(binding.getOrganizationId(), binding.getRunId())
        .orElseThrow(() -> ApiException.conflict("model_credential_unavailable", "Run model credential is unavailable"));
    if (!"active".equals(credential.getCredentialStatus())
        || credential.getSecretCiphertext() == null
        || credential.getSecretCiphertext().isBlank()) {
      throw ApiException.conflict("model_credential_unavailable", "Run model credential is unavailable");
    }
    JsonNode model = Jsons.objectOrEmpty(credential.getModelSnapshot());
    return new ModelEnvironment(vault.modelEnvironment(
        model.path("provider").asText(""),
        model.path("model").asText(""),
        vault.decrypt(credential.getSecretCiphertext())));
  }

  private RunSpec loadRunSpec(WorkerToken binding) {
    RunSpecData row = execution.loadRunSpec(
            binding.getOrganizationId(), binding.getRunId(), binding.getGeneration(), binding.getLeaseId())
        .orElseThrow(() -> ApiException.notFound("Run"));
    JsonNode permission = Jsons.objectOrEmpty(row.getPermissionPolicy());
    List<String> selectedIds = Jsons.stringList(row.getSelectedSourceIds());
    List<RunSpecSource> sources = List.of();
    if (!selectedIds.isEmpty()) {
      List<SourceBlob> selected = execution.loadReadySources(binding.getOrganizationId(), selectedIds);
      if (selected.size() != selectedIds.size()) {
        throw ApiException.conflict(
            "source_not_ready", "Every selected Source must be ready and belong to this Organization");
      }
      Instant expiresAt = Instant.now().plus(Duration.ofMinutes(15));
      sources = selected.stream()
          .map(source -> new RunSpecSource(
              source.getId(),
              source.getKind(),
              source.getDisplayName(),
              safeFileName(source.getDisplayName(), source.getId()),
              source.getMimeType(),
              source.getSizeBytes(),
              source.getSha256(),
              storage.presignGet(source.getBlobKey(), ObjectStorage.Audience.INTERNAL, expiresAt).url(),
              List.of(),
              expiresAt))
          .toList();
    }
    JsonNode repository = row.getRepositoryBinding() != null && row.getRepositoryBinding().isObject()
        ? row.getRepositoryBinding()
        : null;
    String networkAccess = permission.path("networkAccess").asText("");
    if (!List.of("restricted", "connector_proxy_only", "disabled").contains(networkAccess)) {
      networkAccess = permission.path("allowNetworkAccess").asBoolean(false) ? "restricted" : "disabled";
    }
    return new RunSpec(
        2,
        binding.getOrganizationId(),
        row.getProjectId(),
        row.getTaskId(),
        binding.getRunId(),
        binding.getGeneration(),
        binding.getLeaseId(),
        row.getLeaseExpiresAt(),
        Instant.now(),
        new RunSpecTask(
            row.getTaskType(),
            row.getTaskTitle(),
            row.getTaskObjective(),
            Jsons.stringList(row.getTaskConstraints()),
            Jsons.stringList(row.getTaskAcceptanceCriteria()),
            mapMessages(row.getMessages())),
        sources,
        repository,
        Jsons.objectOrEmpty(row.getModelSnapshot()),
        row.getMode(),
        row.getExecutionProfile(),
        new RunSpecPolicy(
            permission,
            Jsons.stringList(permission.get("allowedToolNames")),
            Jsons.stringList(permission.get("connectorInstallationIds")),
            Optional.ofNullable(permission.path("externalActions").asText(null))
                .filter(value -> !value.isBlank())
                .orElse("require_approval"),
            networkAccess),
        row.getResourceLimits(),
        new RunSpecWorkspace(
            "/work",
            "/work/input",
            "/work/output",
            "/work/checkpoint",
            repository == null ? null : "/work/repository"),
        row.getCheckpointKey());
  }

  private Artifact insertArtifact(WorkerToken binding, ArtifactReserveRequest message) {
    String artifactId = UUID.randomUUID().toString();
    ObjectNode metadata = mapper.createObjectNode();
    metadata.set("sourceIds", mapper.valueToTree(Optional.ofNullable(message.sourceIds()).orElse(List.of())));
    Artifact row = new Artifact();
    row.setId(artifactId);
    row.setOrganizationId(binding.getOrganizationId());
    row.setTaskId(message.taskId());
    row.setRunId(message.runId());
    row.setKind(message.kind());
    row.setDisplayName(message.displayName());
    row.setFileName(message.displayName());
    row.setMimeType(Ids.normalizeMime(message.mimeType()));
    row.setSizeBytes(message.sizeBytes());
    row.setSha256(message.sha256());
    row.setPreviousArtifactId(message.parentArtifactId());
    row.setMetadata(metadata);
    row.setGeneration(message.generation());
    row.setReserveIdempotencyKey(message.idempotencyKey());
    row.setUploadBlobKey("staging/artifacts/" + binding.getOrganizationId() + "/" + artifactId);
    if (work.insertArtifact(row) != 1) {
      throw ApiException.notFound("Run");
    }
    return work.findArtifactByReserveKey(binding.getOrganizationId(), message.runId(), message.idempotencyKey())
        .orElseThrow(() -> ApiException.notFound("Artifact"));
  }

  private void insertApproval(WorkerToken binding, JsonNode event) {
    JsonNode approval = event.path("approval");
    JsonNode target = approval.path("target");
    String requestHash = Jsons.text(target, "argumentsHash")
        .or(() -> Jsons.text(target, "planDigest"))
        .orElse(null);
    execution.insertPendingApproval(
        approval.path("id").asText(),
        binding.getOrganizationId(),
        binding.getRunId(),
        target.path("type").asText(null),
        approval.path("scope").asText(null),
        approval.path("riskLevel").asText(null),
        approval.path("actionPreview").asText(null),
        target.isMissingNode() || target.isNull() ? null : target,
        requestHash,
        Jsons.instant(approval, "requestedAt"),
        Jsons.instant(approval, "expiresAt"));
  }

  private WorkerToken authenticate(String token, boolean requireSession) {
    String calculated = hashToken(token);
    WorkerToken binding = execution.authenticateToken(calculated)
        .orElseThrow(() -> new ApiException("worker_unauthenticated", "Invalid or expired run-scoped token", 401));
    if (!safeHashEqual(calculated, binding.getTokenHash())) {
      throw new ApiException("worker_unauthenticated", "Invalid or expired run-scoped token", 401);
    }
    if (requireSession && (binding.getWorkerSessionId() == null || binding.getWorkerSessionId().isBlank())) {
      throw new ApiException("worker_not_registered", "Worker must register before using this token", 401);
    }
    return binding;
  }

  private static void assertBinding(
      WorkerToken binding,
      String runId,
      int generation,
      Optional<String> leaseId,
      Optional<String> sessionId) {
    boolean mismatch = !binding.getRunId().equals(runId)
        || binding.getGeneration() != generation
        || leaseId.filter(id -> !id.equals(binding.getLeaseId())).isPresent()
        || sessionId.filter(id -> !id.equals(binding.getWorkerSessionId())).isPresent();
    if (mismatch) {
      throw new ApiException(
          "worker_token_mismatch", "Message does not match the run-scoped token binding", 401);
    }
  }

  private static void assertReservation(Artifact row, ArtifactReserveRequest message) {
    JsonNode metadata = Jsons.objectOrEmpty(row.getMetadata());
    boolean same = Objects.equals(row.getGeneration(), message.generation())
        && Objects.equals(row.getTaskId(), message.taskId())
        && Objects.equals(row.getKind(), message.kind())
        && Objects.equals(row.getDisplayName(), message.displayName())
        && Ids.normalizeMime(Optional.ofNullable(row.getMimeType()).orElse(""))
            .equals(Ids.normalizeMime(message.mimeType()))
        && Objects.equals(row.getSizeBytes(), message.sizeBytes())
        && Objects.equals(row.getSha256(), message.sha256())
        && Objects.equals(row.getPreviousArtifactId(), message.parentArtifactId())
        && Jsons.stringList(metadata.get("sourceIds"))
            .equals(Optional.ofNullable(message.sourceIds()).orElse(List.of()));
    if (!same) {
      throw ApiException.conflict(
          "artifact_idempotency_conflict", "Artifact idempotency key was used for another reservation");
    }
  }

  private static ArtifactReserved reserved(
      ArtifactReserveRequest message, Artifact row, boolean committed, Optional<ArtifactUpload> upload) {
    return new ArtifactReserved(
        2,
        "artifact.reserved",
        WorkerProtocol.messageId(),
        Instant.now(),
        message.idempotencyKey(),
        message.runId(),
        message.generation(),
        row.getId(),
        committed,
        upload.orElse(null));
  }

  private static ArtifactCommitted committed(ArtifactCommitRequest message, Artifact row) {
    JsonNode metadata = Jsons.objectOrEmpty(row.getMetadata());
    Instant readyAt = Optional.ofNullable(row.getReadyAt()).orElse(Instant.now());
    return new ArtifactCommitted(
        2,
        "artifact.committed",
        WorkerProtocol.messageId(),
        Instant.now(),
        message.idempotencyKey(),
        message.runId(),
        message.generation(),
        new CommittedArtifact(
            row.getId(),
            row.getOrganizationId(),
            row.getProjectId(),
            row.getTaskId(),
            row.getKind(),
            "ready",
            row.getDisplayName(),
            row.getMimeType(),
            Optional.ofNullable(row.getSizeBytes()).orElse(0L),
            row.getSha256(),
            Jsons.stringList(metadata.get("sourceIds")),
            metadata.hasNonNull("previewBlobKey"),
            "/api/v2/artifacts/" + row.getId() + "/content",
            readyAt,
            row.getCreatedAt(),
            row.getPreviousArtifactId()));
  }

  private static List<RunSpecMessage> mapMessages(JsonNode messages) {
    if (messages == null || !messages.isArray()) {
      return List.of();
    }
    List<RunSpecMessage> result = new ArrayList<>();
    messages.forEach(item -> {
      StringBuilder text = new StringBuilder();
      JsonNode content = item.path("content");
      if (content.isArray()) {
        content.forEach(block -> {
          if ("text".equals(block.path("type").asText())) {
            String value = block.path("text").asText("");
            if (!value.isBlank()) {
              if (text.length() > 0) {
                text.append('\n');
              }
              text.append(value);
            }
          }
        });
      }
      Instant createdAt = Optional.ofNullable(Jsons.instant(item, "created_at"))
          .or(() -> Optional.ofNullable(Jsons.instant(item, "createdAt")))
          .orElse(Instant.now());
      result.add(new RunSpecMessage(
          item.path("id").asText(),
          item.path("role").asText(),
          text.toString(),
          createdAt));
    });
    return List.copyOf(result);
  }

  private static String safeFileName(String value, String fallback) {
    String normalized = Normalizer.normalize(Optional.ofNullable(value).orElse(""), Normalizer.Form.NFKC)
        .replaceAll("[^A-Za-z0-9._ -]+", "_")
        .replaceAll("^\\.+", "");
    if (normalized.length() > 240) {
      normalized = normalized.substring(0, 240);
    }
    return !normalized.isEmpty() && normalized.matches("^[A-Za-z0-9].*") ? normalized : fallback + ".bin";
  }

  private static String hashToken(String token) {
    return HexFormat.of().formatHex(sha256(token.getBytes(StandardCharsets.UTF_8)));
  }

  private static byte[] sha256(byte[] value) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(value);
    } catch (GeneralSecurityException error) {
      throw new IllegalStateException(error);
    }
  }

  private static boolean safeHashEqual(String left, String right) {
    try {
      byte[] leftBytes = HexFormat.of().parseHex(Optional.ofNullable(left).orElse(""));
      byte[] rightBytes = HexFormat.of().parseHex(Optional.ofNullable(right).orElse(""));
      return leftBytes.length == rightBytes.length && MessageDigest.isEqual(leftBytes, rightBytes);
    } catch (IllegalArgumentException error) {
      return false;
    }
  }
}
