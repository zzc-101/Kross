package com.kross.work;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.kross.api.ApiException;
import com.kross.execution.ExecutionMapper;
import com.kross.execution.RunScheduler;
import com.kross.execution.entity.Run;
import com.kross.execution.entity.TaskLock;
import com.kross.execution.entity.UsableModel;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.storage.ObjectStorage;
import com.kross.support.Ids;
import com.kross.support.Policies;
import com.kross.work.dto.AppendMessageRequest;
import com.kross.work.dto.ArtifactView;
import com.kross.work.dto.CompleteSourceRequest;
import com.kross.work.dto.CreateExternalSourceRequest;
import com.kross.work.dto.CreateInlineSourceRequest;
import com.kross.work.dto.CreateProjectRequest;
import com.kross.work.dto.CreateRunRequest;
import com.kross.work.dto.CreateTaskRequest;
import com.kross.work.dto.CreateUploadSourceRequest;
import com.kross.work.dto.ProjectView;
import com.kross.work.dto.RunView;
import com.kross.work.dto.SourceUploadView;
import com.kross.work.dto.SourceView;
import com.kross.work.dto.TaskMessageView;
import com.kross.work.dto.TaskView;
import com.kross.work.dto.UploadHeader;
import com.kross.work.dto.UploadInstruction;
import com.kross.work.dto.WorkViews;
import com.kross.work.entity.Artifact;
import com.kross.work.entity.Project;
import com.kross.work.entity.Source;
import com.kross.work.entity.Task;
import com.kross.work.entity.TaskMessage;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class WorkService {
  private final OrganizationAccess access;
  private final WorkMapper work;
  private final ExecutionMapper execution;
  private final ObjectStorage storage;
  private final ObjectMapper mapper;
  private final RunScheduler scheduler;

  public List<ProjectView> listProjects(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.PROJECT_READ);
    return work.listProjects(context.organizationId()).stream().map(WorkViews::project).toList();
  }

  @Transactional
  public ProjectView createProject(String organizationId, CreateProjectRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.PROJECT_CREATE);
    String kind = WorkViews.text(request.kind()).orElse("general");
    String name = required(request.name(), "name");
    if ("repository".equals(kind) && request.repository() == null) {
      throw ApiException.invalidRequest("Repository project requires repository binding");
    }
    String id = UUID.randomUUID().toString();
    Instant now = Instant.now();
    work.insertProject(new Project(
        id,
        context.organizationId(),
        kind,
        name,
        WorkViews.text(request.description()).orElse(null),
        "active",
        request.repository(),
        Policies.defaultPermissionPolicy(false),
        WorkViews.text(request.defaultTaskType()).orElse("general"),
        context.userId(),
        now,
        now));
    return WorkViews.project(work.findProject(context.organizationId(), id).orElseThrow());
  }

  public ProjectView getProject(String organizationId, String projectId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.PROJECT_READ);
    return WorkViews.project(work.findProject(
            context.organizationId(), Ids.requireResourceId(projectId, "Invalid Project identifier"))
        .orElseThrow(() -> ApiException.notFound("Project")));
  }

  public List<TaskView> listTasks(String organizationId, String projectId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.TASK_READ);
    return work.listTasks(context.organizationId(), Ids.requireResourceId(projectId, "Invalid Project identifier"))
        .stream()
        .map(WorkViews::task)
        .toList();
  }

  @Transactional
  public TaskView createTask(String organizationId, CreateTaskRequest request, String idempotencyKey) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.TASK_CREATE);
    return idempotent(context, "task.create", idempotencyKey, mapper.valueToTree(request), TaskView.class, () -> {
      String projectId = Ids.requireResourceId(required(request.projectId(), "projectId"), "Invalid Project identifier");
      String id = UUID.randomUUID().toString();
      Instant now = Instant.now();
      work.insertTask(new Task(
          id,
          context.organizationId(),
          projectId,
          required(request.type(), "type"),
          required(request.title(), "title"),
          required(request.objective(), "objective"),
          mapper.valueToTree(Optional.ofNullable(request.constraints()).orElse(List.of())),
          mapper.valueToTree(Optional.ofNullable(request.acceptanceCriteria()).orElse(List.of())),
          "open",
          null,
          context.userId(),
          now,
          now));
      return WorkViews.task(work.findTask(context.organizationId(), id).orElseThrow(() -> ApiException.notFound("Project")));
    });
  }

  public TaskView getTask(String organizationId, String taskId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.TASK_READ);
    return WorkViews.task(work.findTask(context.organizationId(), Ids.requireResourceId(taskId, "Invalid Task identifier"))
        .orElseThrow(() -> ApiException.notFound("Task")));
  }

  public List<TaskMessageView> listMessages(String organizationId, String taskId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.TASK_READ);
    return work.listMessages(context.organizationId(), Ids.requireResourceId(taskId, "Invalid Task identifier"))
        .stream()
        .map(WorkViews::message)
        .toList();
  }

  @Transactional
  public TaskMessageView appendMessage(String organizationId, String taskId, AppendMessageRequest request, String key) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.TASK_CREATE);
    ObjectNode command = mapper.createObjectNode();
    command.put("taskId", taskId);
    command.set("content", request.content());
    return idempotent(context, "task_message.append", key, command, TaskMessageView.class, () -> {
      String id = UUID.randomUUID().toString();
      Task task = work.findTask(context.organizationId(), Ids.requireResourceId(taskId, "Invalid Task identifier"))
          .orElseThrow(() -> ApiException.notFound("Task"));
      work.insertMessage(new TaskMessage(
          id,
          context.organizationId(),
          task.getProjectId(),
          task.getId(),
          null,
          "user",
          request.content(),
          context.userId(),
          Instant.now()));
      return work.listMessages(context.organizationId(), task.getId()).stream()
          .filter(row -> id.equals(row.getId()))
          .findFirst()
          .map(WorkViews::message)
          .orElseThrow();
    });
  }

  public List<SourceView> listSources(String organizationId, String projectId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SOURCE_READ);
    return work.listSources(context.organizationId(), Ids.requireResourceId(projectId, "Invalid Project identifier"))
        .stream()
        .map(WorkViews::source)
        .toList();
  }

  @Transactional
  public SourceUploadView createUpload(String organizationId, String projectId, CreateUploadSourceRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SOURCE_CREATE);
    String sourceId = UUID.randomUUID().toString();
    String stagingKey = "staging/sources/" + context.organizationId() + "/" + sourceId;
    String mimeType = Ids.normalizeMime(required(request.mimeType(), "mimeType"));
    ObjectNode metadata = mapper.createObjectNode();
    metadata.put("stagingBlobKey", stagingKey);
    metadata.put("expectedMimeType", mimeType);
    Optional.ofNullable(request.sizeBytes()).ifPresent(value -> metadata.put("expectedSizeBytes", value));
    WorkViews.text(request.sha256()).ifPresent(value -> metadata.put("expectedSha256", Ids.requireSha256(value)));
    insertSource(context, sourceId, projectId, request.scope(), request.taskId(), request.displayName(),
        request.previousSourceId(), "upload", "uploading", mimeType, null, mapper.createObjectNode().put("kind", "upload"),
        metadata, null);
    Instant expiresAt = Instant.now().plus(Duration.ofMinutes(15));
    ObjectStorage.SignedUrl upload = storage.presignPut(stagingKey, ObjectStorage.Audience.PUBLIC, mimeType, expiresAt);
    return WorkViews.sourceUpload(
        work.findSource(context.organizationId(), sourceId).orElseThrow(),
        new UploadInstruction("PUT", upload.url(), List.of(new UploadHeader("content-type", mimeType)), expiresAt));
  }

  @Transactional
  public SourceView createInline(String organizationId, String projectId, CreateInlineSourceRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SOURCE_CREATE);
    byte[] bytes = required(request.content(), "content").getBytes(StandardCharsets.UTF_8);
    String sha256 = sha256(bytes);
    String blobKey = ObjectStorage.contentAddressedKey(sha256);
    String mimeType = Ids.normalizeMime(required(request.mimeType(), "mimeType"));
    if (storage.head(blobKey).isEmpty()) {
      storage.putBytes(blobKey, bytes, mimeType);
    }
    String sourceId = UUID.randomUUID().toString();
    insertSource(context, sourceId, projectId, request.scope(), request.taskId(), request.displayName(),
        request.previousSourceId(), "generated", "ready", mimeType, null,
        mapper.createObjectNode().put("kind", "generated"), mapper.createObjectNode(),
        new ReadyBlob(bytes.length, sha256, blobKey));
    return WorkViews.source(work.findSource(context.organizationId(), sourceId).orElseThrow());
  }

  @Transactional
  public SourceView createExternal(String organizationId, String projectId, CreateExternalSourceRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SOURCE_CREATE);
    String kind = required(request.kind(), "kind");
    String locator = required(request.locator(), "locator");
    if ("url".equals(kind) && !locator.startsWith("https://")) {
      throw new ApiException("unsafe_source_url", "Only HTTPS Source URLs are accepted", 400);
    }
    String sourceId = UUID.randomUUID().toString();
    JsonNode origin = Optional.ofNullable(request.origin()).orElseGet(() -> mapper.createObjectNode().put("kind", kind));
    insertSource(context, sourceId, projectId, request.scope(), request.taskId(), request.displayName(),
        request.previousSourceId(), kind, "processing", null, locator, origin,
        mapper.createObjectNode().put("ingestionRequired", true), null);
    return WorkViews.source(work.findSource(context.organizationId(), sourceId).orElseThrow());
  }

  @Transactional
  public SourceView completeSource(String organizationId, String sourceId, CompleteSourceRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.SOURCE_CREATE);
    Source source = work.findSource(
            context.organizationId(), Ids.requireResourceId(sourceId, "Invalid Source identifier"))
        .orElseThrow(() -> ApiException.notFound("Source"));
    long sizeBytes = request.sizeBytes();
    String sha256 = Ids.requireSha256(required(request.sha256(), "sha256"));
    String mimeType = Ids.normalizeMime(required(request.mimeType(), "mimeType"));
    if ("ready".equals(source.getStatus())) {
      if (Long.valueOf(sizeBytes).equals(source.getSizeBytes()) && sha256.equals(source.getSha256())) {
        return WorkViews.source(source);
      }
      throw ApiException.conflict("source_already_finalized", "Source was finalized with different content");
    }
    if (!"uploading".equals(source.getStatus())) {
      throw ApiException.conflict("source_not_uploading", "Source is not awaiting upload completion");
    }
    String stagingKey = source.getMetadata().path("stagingBlobKey").asText("");
    ObjectStorage.ObjectStat uploaded = storage.head(stagingKey)
        .orElseThrow(() -> new ApiException("blob_not_found", "Uploaded blob not found", 404));
    if (uploaded.sizeBytes() != sizeBytes) {
      throw new ApiException("blob_size_mismatch", "Uploaded size does not match", 422);
    }
    String finalKey = ObjectStorage.contentAddressedKey(sha256);
    storage.copy(stagingKey, finalKey);
    storage.delete(stagingKey);
    ObjectNode metadata = source.getMetadata().deepCopy();
    metadata.remove("stagingBlobKey");
    source.setMimeType(mimeType);
    source.setSizeBytes(sizeBytes);
    source.setSha256(sha256);
    source.setBlobKey(finalKey);
    source.setMetadata(metadata);
    work.finalizeSource(source);
    return WorkViews.source(work.findSource(context.organizationId(), source.getId()).orElseThrow());
  }

  public List<ArtifactView> listArtifacts(String organizationId, String taskId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.ARTIFACT_READ);
    return work.listArtifacts(context.organizationId(), Ids.requireResourceId(taskId, "Invalid Task identifier"))
        .stream()
        .map(WorkViews::artifact)
        .toList();
  }

  public ArtifactView getArtifact(String organizationId, String artifactId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.ARTIFACT_READ);
    Artifact row = work.findArtifact(
            context.organizationId(), Ids.requireResourceId(artifactId, "Invalid Artifact identifier"))
        .orElseThrow(() -> ApiException.notFound("Artifact"));
    return WorkViews.artifact(row);
  }

  public String artifactContentUrl(String organizationId, String artifactId) {
    ArtifactView artifact = getArtifact(organizationId, artifactId);
    if (!"ready".equals(artifact.status()) || artifact.blobKey() == null) {
      throw new ApiException("artifact_not_ready", "Artifact content is not ready", 409);
    }
    return storage.presignGet(
            artifact.blobKey(), ObjectStorage.Audience.PUBLIC, Instant.now().plus(Duration.ofMinutes(15)))
        .url();
  }

  @Transactional
  public RunView createRun(String organizationId, String taskId, CreateRunRequest request, String key) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.RUN_CREATE);
    ObjectNode command = mapper.createObjectNode();
    command.put("taskId", taskId);
    command.put("mode", WorkViews.text(request.mode()).orElse("auto"));
    command.set("selectedSourceIds", mapper.valueToTree(Optional.ofNullable(request.selectedSourceIds()).orElse(List.of())));
    WorkViews.text(request.requestedModelProfileId()).ifPresent(value -> command.put("requestedModelProfileId", value));
    return idempotent(context, "run.create", key, command, RunView.class, () -> insertRun(context, command));
  }

  public RunView getRun(String organizationId, String runId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.RUN_READ);
    return WorkViews.run(execution.findRun(
            context.organizationId(), Ids.requireResourceId(runId, "Invalid Run identifier"))
        .orElseThrow(() -> ApiException.notFound("Run")));
  }

  public RunView cancelRun(String organizationId, String runId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.RUN_CANCEL);
    String parsed = Ids.requireResourceId(runId, "Invalid Run identifier");
    if (execution.requestCancel(context.organizationId(), parsed) == 0) {
      throw ApiException.notFound("Run");
    }
    RunView run = WorkViews.run(
        execution.findRun(context.organizationId(), parsed).orElseThrow(() -> ApiException.notFound("Run")));
    if ("cancelling".equals(run.status())) {
      scheduler.cancel(parsed, context.organizationId());
    }
    return WorkViews.run(
        execution.findRun(context.organizationId(), parsed).orElseThrow(() -> ApiException.notFound("Run")));
  }

  private RunView insertRun(OrganizationContext context, JsonNode command) {
    TaskLock task = execution.lockTask(context.organizationId(), command.path("taskId").asText())
        .orElseThrow(() -> ApiException.notFound("Task"));
    UsableModel model = execution.findUsableModel(
            context.organizationId(),
            command.hasNonNull("requestedModelProfileId")
                ? command.path("requestedModelProfileId").asText()
                : null)
        .orElseThrow(() -> ApiException.conflict("model_profile_required", "请先在管理端配置带 API Key 的模型档案后再执行任务"));
    String id = UUID.randomUUID().toString();
    try {
      JsonNode selectedSourceIds = command.path("selectedSourceIds").isArray()
          ? command.get("selectedSourceIds")
          : mapper.createArrayNode();
      execution.insertRun(new Run(
          id,
          context.organizationId(),
          task.getProjectId(),
          task.getId(),
          task.getLastAttempt() + 1,
          "queued",
          command.path("mode").asText("auto"),
          Policies.modelSnapshot(model.getProvider(), model.getModel(), model.getCredentialHandleId()),
          Policies.defaultPermissionPolicy(true),
          Policies.defaultResourceLimits(),
          selectedSourceIds,
          Policies.emptyUsage(),
          Instant.now(),
          null,
          null,
          context.userId()));
      execution.insertLease(id, context.organizationId());
      work.setLatestRun(context.organizationId(), task.getId(), id);
      return WorkViews.run(execution.findRun(context.organizationId(), id).orElseThrow());
    } catch (DuplicateKeyException error) {
      throw ApiException.conflict("active_run_exists", "Task already has an active Run");
    }
  }

  private void insertSource(
      OrganizationContext context,
      String sourceId,
      String projectId,
      String scopeValue,
      String taskIdValue,
      String displayName,
      String previousSourceId,
      String kind,
      String status,
      String mimeType,
      String locator,
      JsonNode origin,
      JsonNode metadata,
      ReadyBlob ready) {
    String scope = WorkViews.text(scopeValue).orElse("project");
    Optional<String> taskId = WorkViews.text(taskIdValue);
    if ("task".equals(scope) != taskId.isPresent()) {
      throw new ApiException("invalid_source_scope", "Task Source requires taskId", 400);
    }
    work.insertSource(new Source(
        sourceId,
        context.organizationId(),
        Ids.requireResourceId(projectId, "Invalid Project identifier"),
        taskId.orElse(null),
        kind,
        scope,
        status,
        required(displayName, "displayName"),
        Optional.ofNullable(mimeType).orElse(null),
        ready == null ? null : (long) ready.sizeBytes(),
        ready == null ? null : ready.sha256(),
        ready == null ? null : ready.blobKey(),
        locator,
        origin,
        WorkViews.text(previousSourceId).orElse(null),
        metadata,
        context.userId(),
        Instant.now()));
  }

  private <T> T idempotent(
      OrganizationContext context,
      String scope,
      String rawKey,
      JsonNode command,
      Class<T> type,
      Supplier<T> operation) {
    if (rawKey == null || rawKey.isBlank()) {
      throw new ApiException("idempotency_key_required", "Idempotency-Key is required", 400);
    }
    String hash = sha256(command.toString().getBytes(StandardCharsets.UTF_8));
    JsonNode existing = execution.findIdempotency(context.organizationId(), scope, rawKey).orElse(null);
    if (existing != null) {
      String existingHash = execution.findIdempotencyHash(context.organizationId(), scope, rawKey).orElse("");
      if (!hash.equals(existingHash)) {
        throw ApiException.conflict("idempotency_conflict", "Idempotency key was used for another request");
      }
      if (existing.isNull()) {
        throw ApiException.conflict("idempotency_in_progress", "Idempotent request is still in progress");
      }
      return mapper.convertValue(existing, type);
    }
    if (execution.reserveIdempotency(context.organizationId(), scope, rawKey, hash) == 0) {
      return idempotent(context, scope, rawKey, command, type, operation);
    }
    try {
      T result = operation.get();
      execution.completeIdempotency(
          context.organizationId(), scope, rawKey, hash, 201, mapper.valueToTree(result), resourceId(result));
      return result;
    } catch (RuntimeException error) {
      execution.abandonIdempotency(context.organizationId(), scope, rawKey, hash);
      throw error;
    }
  }

  private static String resourceId(Object result) {
    if (result instanceof ProjectView project) {
      return project.id();
    }
    if (result instanceof TaskView task) {
      return task.id();
    }
    if (result instanceof TaskMessageView message) {
      return message.id();
    }
    if (result instanceof RunView run) {
      return run.id();
    }
    return null;
  }

  private static String required(String value, String field) {
    return WorkViews.text(value).orElseThrow(() -> ApiException.invalidRequest("Missing " + field));
  }

  private static String sha256(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }

  private record ReadyBlob(int sizeBytes, String sha256, String blobKey) {}
}
