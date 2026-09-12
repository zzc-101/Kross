package com.kross.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.AgentModelView;
import com.kross.agent.dto.AgentProtocol;
import com.kross.agent.dto.AgentViews;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.ConversationView;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.CreateMemoryRequest;
import com.kross.agent.dto.MemoryView;
import com.kross.agent.dto.PatchConversationRequest;
import com.kross.agent.dto.PatchMemoryRequest;
import com.kross.agent.dto.RememberMemoryRequest;
import com.kross.agent.dto.ResolveToolApprovalRequest;
import com.kross.agent.dto.SkillView;
import com.kross.agent.dto.WorkspaceDirectoryRequest;
import com.kross.agent.dto.WorkspaceFileRef;
import com.kross.agent.dto.WorkspaceFileUrlView;
import com.kross.agent.dto.WorkspaceFileView;
import com.kross.agent.dto.WorkspaceListingView;
import com.kross.agent.dto.WorkspaceStoredFileView;
import com.kross.agent.dto.WorkspaceUploadCommitRequest;
import com.kross.agent.dto.WorkspaceUploadRequest;
import com.kross.agent.dto.WorkspaceUploadView;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentRuntimeRow;
import com.kross.agent.entity.UsageCounts;
import com.kross.api.ApiException;
import com.kross.catalog.SkillCatalogService;
import com.kross.catalog.entity.PlatformSkill;
import com.kross.channel.AgentSocketHub;
import com.kross.channel.ChannelEventBus;
import com.kross.channel.MessageParts;
import com.kross.channel.WorkerOfferBus;
import com.kross.config.AppProperties;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.observability.RequestLogContext;
import com.kross.storage.ObjectStorage;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Slf4j
@Service
@RequiredArgsConstructor
public class AgentConversationService {
  private static final int DEFAULT_MESSAGE_LIMIT = 100;
  private static final int MAX_MESSAGE_LIMIT = 500;
  private static final int MAX_CONTENT_CHARS = 32_768;
  private static final int MAX_MESSAGE_FILES = 10;
  private static final long MAX_WORKSPACE_FILE_BYTES = 10L * 1024 * 1024;
  private static final Duration WORKSPACE_COMMAND_TIMEOUT = Duration.ofSeconds(30);
  private static final Duration WORKSPACE_TRANSFER_TIMEOUT = Duration.ofSeconds(60);

  private final AgentMapper agents;
  private final OrganizationAccess access;
  private final ChannelEventBus channelEvents;
  private final AgentSocketHub sockets;
  private final WorkerOfferBus offers;
  private final ObjectMapper mapper;
  private final AgentMemoryService memories;
  private final SkillCatalogService skills;
  private final ModelCatalog models;
  private final AgentRuntimeOps runtime;
  private final AgentTransactions transactions;
  private final AgentChannelPublisher channels;
  private final ObjectStorage storage;
  private final AppProperties properties;

  public List<AgentModelView> listModels(String organizationId) {
    access.require(organizationId, OrganizationAction.AGENT_READ);
    return models.listUsable().stream()
        .map(ModelCatalog.UsableModel::toView)
        .toList();
  }

  public List<ConversationView> listConversations(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = runtime.ensure(context);
    runtime.wakeQuietly(agent);
    return agents.listConversations(context.organizationId(), agent.getId()).stream()
        .map(AgentViews::conversation)
        .toList();
  }

  @Transactional
  public ConversationView createConversation(String organizationId, CreateConversationRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    PlatformSkill skill = Optional.ofNullable(request.skillId())
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .map(value -> skills.findInstalledSkill(context.organizationId(), value)
            .orElseThrow(() -> ApiException.notFound("Installed Skill")))
        .orElse(null);
    String title = Optional.ofNullable(request.title()).map(String::trim).filter(value -> !value.isEmpty())
        .orElseGet(() -> skill == null ? AgentRuntimeOps.DEFAULT_TITLE : skill.getName());
    String modelId = Optional.ofNullable(request.modelId())
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .map(runtime::requireUsableModelId)
        .orElse(null);
    return AgentViews.conversation(runtime.insertConversation(context.organizationId(), agent, title,
        skill == null ? null : skill.getId(), modelId));
  }

  @Transactional
  public ConversationView patchConversation(
      String organizationId, String conversationId, PatchConversationRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    AgentConversation conversation = runtime.requireConversation(context, agent, conversationId);
    Optional.ofNullable(request.title())
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .ifPresent(title -> conversation.setTitle(AgentRuntimeOps.clipTitle(title)));
    Optional.ofNullable(request.archived()).ifPresent(archived -> {
      if (Boolean.TRUE.equals(archived)) {
        conversation.setArchivedAt(Optional.ofNullable(conversation.getArchivedAt()).orElse(Instant.now()));
      } else {
        conversation.setArchivedAt(null);
      }
    });
    Optional.ofNullable(request.modelId()).ifPresent(modelId -> {
      String trimmed = modelId.trim();
      if (trimmed.isEmpty()) {
        conversation.setModelId(null);
      } else {
        conversation.setModelId(runtime.requireUsableModelId(trimmed));
      }
    });
    agents.updateConversation(conversation);
    return AgentViews.conversation(
        agents.findConversation(context.organizationId(), conversation.getId()).orElse(conversation));
  }

  @Transactional
  public AgentMessageView appendMessage(
      String organizationId, String conversationId, AppendAgentMessageRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    String content = Optional.ofNullable(request.content()).orElse("").trim();
    List<WorkspaceFileRef> files = Optional.ofNullable(request.files()).orElse(List.of());
    if (files.size() > MAX_MESSAGE_FILES) {
      throw ApiException.invalidRequest("Too many attachments");
    }
    if (content.isEmpty() && files.isEmpty()) {
      throw ApiException.invalidRequest("Message content is required");
    }
    if (content.length() > MAX_CONTENT_CHARS) {
      throw ApiException.invalidRequest("Message content is too long");
    }
    Agent agent = runtime.ensure(context);
    AgentConversation conversation = runtime.requireConversation(context, agent, conversationId);
    if (Optional.ofNullable(conversation.getArchivedAt()).isPresent()) {
      throw ApiException.invalidRequest("Archived conversations cannot accept messages");
    }
    AgentMessage row = new AgentMessage();
    row.setId(UUID.randomUUID().toString());
    row.setOrganizationId(context.organizationId());
    row.setAgentId(agent.getId());
    row.setConversationId(conversation.getId());
    row.setRole("user");
    row.setContent(content);
    ArrayNode parts = MessageParts.empty(mapper);
    for (WorkspaceFileRef file : files) {
      MessageParts.appendFile(
          parts,
          requireRelativePath(file.path(), false),
          Optional.ofNullable(file.mimeType()).orElse("application/octet-stream"),
          Optional.ofNullable(file.name()).map(String::trim).filter(value -> !value.isEmpty())
              .orElseGet(() -> fileName(file.path())));
    }
    row.setParts(parts);
    row.setStatus("queued");
    row.setCreatedBy(context.userId());
    row.setCreatedAt(Instant.now());
    agents.insertMessage(row);
    if (AgentRuntimeOps.DEFAULT_TITLE.equals(conversation.getTitle())) {
      String titleSource = content.isEmpty()
          ? files.stream().map(WorkspaceFileRef::name).filter(name -> name != null && !name.isBlank()).findFirst()
              .orElse("附件")
          : content;
      conversation.setTitle(AgentRuntimeOps.clipTitle(titleSource));
      agents.updateConversation(conversation);
    }
    agents.touchConversation(conversation.getId());
    agents.touch(agent.getId());
    memories.captureRememberPhrase(context, agent, content);
    channels.emitUpsert(row);
    RequestLogContext.put(RequestLogContext.CONVERSATION_ID, conversation.getId());
    RequestLogContext.bindAgent(agent);
    Agent toWake = agent;
    transactions.afterCommit(() -> Thread.ofVirtual().start(RequestLogContext.propagate(() -> {
      try {
        runtime.wake(toWake);
      } catch (RuntimeException error) {
        log.warn("Failed to wake agent {}: {}", toWake.getId(), error.getMessage());
      }
      offers.offer(toWake.getId());
    })));
    return AgentViews.message(row);
  }

  public List<AgentMessageView> listMessages(
      String organizationId, String conversationId, Optional<Integer> limit) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = runtime.ensure(context);
    runtime.requireConversation(context, agent, conversationId);
    int pageSize = Math.min(Math.max(limit.orElse(DEFAULT_MESSAGE_LIMIT), 1), MAX_MESSAGE_LIMIT);
    return agents.listMessages(context.organizationId(), conversationId, pageSize).stream()
        .map(AgentViews::message)
        .toList();
  }

  @Transactional
  public void resolveApproval(
      String organizationId,
      String conversationId,
      String approvalId,
      ResolveToolApprovalRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    runtime.requireConversation(context, agent, conversationId);
    String normalizedApprovalId = AgentRuntimeOps.requireProtocolId(approvalId, "approvalId");
    String reason = Optional.ofNullable(request.reason())
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .orElse(null);
    if (reason != null && reason.length() > 2_000) {
      throw ApiException.invalidRequest("Approval reason is too long");
    }
    String status = request.approved() ? "approved" : "rejected";
    int updated = agents.resolvePendingApproval(
        agent.getId(),
        normalizedApprovalId,
        context.organizationId(),
        conversationId,
        status,
        reason,
        context.userId(),
        Instant.now());
    if (updated == 0) {
      if (!agents.hasApproval(agent.getId(), normalizedApprovalId, context.organizationId(), conversationId)) {
        throw ApiException.notFound("Approval");
      }
      if (!agents.hasApprovalDecision(
          agent.getId(), normalizedApprovalId, context.organizationId(), conversationId, status, reason)) {
        throw ApiException.conflict("approval_already_resolved", "Approval was already resolved differently");
      }
    }
    AgentProtocol.ApprovalDecision decision =
        new AgentProtocol.ApprovalDecision(normalizedApprovalId, request.approved(), reason);
    transactions.afterCommit(() -> sockets.sendRequired(agent.getId(), decision));
  }

  public WorkspaceListingView listWorkspace(String organizationId, String path) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = runtime.ensure(context);
    Map<String, Object> payload = runtime.runWorkspaceCommand(
        agent,
        "workspace.list",
        Map.of("path", Optional.ofNullable(path).orElse(".")),
        WORKSPACE_COMMAND_TIMEOUT);
    return mapper.convertValue(payload, WorkspaceListingView.class);
  }

  public WorkspaceFileView readWorkspaceFile(String organizationId, String path) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = runtime.ensure(context);
    Map<String, Object> payload = runtime.runWorkspaceCommand(
        agent,
        "workspace.read",
        Map.of("path", path),
        WORKSPACE_COMMAND_TIMEOUT);
    return mapper.convertValue(payload, WorkspaceFileView.class);
  }

  public WorkspaceUploadView prepareWorkspaceUpload(String organizationId, WorkspaceUploadRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    WorkspaceUploadRequest upload = Optional.ofNullable(request)
        .orElseThrow(() -> ApiException.invalidRequest("file is required"));
    requireFileSize(upload.size());
    String name = fileName(upload.name());
    requireRelativePath(Optional.ofNullable(upload.directory()).orElse("."), true);
    String mimeType = requireMimeType(upload.mimeType());
    Instant expiresAt = signedExpiry();
    String key = WorkspaceObjectKeys.stagingKey(context.organizationId(), agent.getId());
    ObjectStorage.SignedUrl signed = storage.presignPut(key, ObjectStorage.Audience.PUBLIC, mimeType, expiresAt);
    return new WorkspaceUploadView(key, signed.method(), signed.url(), signed.expiresAt(), mimeType);
  }

  public WorkspaceStoredFileView commitWorkspaceUpload(
      String organizationId, WorkspaceUploadCommitRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    WorkspaceUploadCommitRequest upload = Optional.ofNullable(request)
        .orElseThrow(() -> ApiException.invalidRequest("file is required"));
    requireFileSize(upload.size());
    String key = Optional.ofNullable(upload.key()).map(String::trim).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("Upload key is required"));
    if (!WorkspaceObjectKeys.isStagingKey(context.organizationId(), agent.getId(), key)) {
      throw ApiException.invalidRequest("Invalid upload key");
    }
    ObjectStorage.ObjectStat staged = storage.head(key)
        .orElseThrow(() -> ApiException.invalidRequest("Uploaded blob not found"));
    if (staged.sizeBytes() != upload.size()) {
      throw ApiException.invalidRequest("Uploaded size does not match");
    }
    String name = fileName(upload.name());
    String dir = requireRelativePath(Optional.ofNullable(upload.directory()).orElse("."), true);
    String requested = ".".equals(dir) ? name : dir + "/" + name;
    String mimeType = requireMimeType(upload.mimeType());
    Instant expiresAt = signedExpiry();
    ObjectStorage.SignedUrl pull = storage.presignGet(key, ObjectStorage.Audience.INTERNAL, expiresAt);
    Map<String, Object> pulled = runtime.runWorkspaceCommand(
        agent,
        "workspace.pull",
        Map.of(
            "path", requested,
            "url", pull.url(),
            "totalSize", staged.sizeBytes(),
            "ifExists", "rename"),
        WORKSPACE_TRANSFER_TIMEOUT);
    String path = String.valueOf(pulled.getOrDefault("path", requested));
    long size = numberValue(pulled.get("size"), staged.sizeBytes());
    String finalKey = WorkspaceObjectKeys.objectKey(context.organizationId(), agent.getId(), path);
    if (!finalKey.equals(key)) {
      storage.copy(key, finalKey);
      storage.delete(key);
    }
    ObjectStorage.SignedUrl signed = publicFileUrl(finalKey, fileName(path), mimeType, false, expiresAt);
    return new WorkspaceStoredFileView(path, size, mimeType, fileName(path), signed.url(), signed.expiresAt());
  }

  public WorkspaceFileUrlView workspaceFileUrl(String organizationId, String path, boolean inline) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = runtime.ensure(context);
    String relative = requireRelativePath(path, false);
    String filename = fileName(relative);
    String mimeType = downloadContentType(filename);
    String key = WorkspaceObjectKeys.objectKey(context.organizationId(), agent.getId(), relative);
    Instant expiresAt = signedExpiry();
    if (storage.head(key).isEmpty()) {
      ObjectStorage.SignedUrl put = storage.presignPut(key, ObjectStorage.Audience.INTERNAL, mimeType, expiresAt);
      runtime.runWorkspaceCommand(
          agent,
          "workspace.push",
          Map.of(
              "path", relative,
              "url", put.url(),
              "mimeType", mimeType),
          WORKSPACE_TRANSFER_TIMEOUT);
    }
    ObjectStorage.SignedUrl signed = publicFileUrl(key, filename, mimeType, inline, expiresAt);
    return new WorkspaceFileUrlView(relative, signed.url(), signed.expiresAt(), mimeType, filename, inline);
  }

  public void redirectWorkspaceFile(
      String organizationId, String path, boolean inline, HttpServletResponse response) {
    WorkspaceFileUrlView signed = workspaceFileUrl(organizationId, path, inline);
    response.setStatus(HttpServletResponse.SC_FOUND);
    response.setHeader(HttpHeaders.LOCATION, signed.url());
    response.setHeader(HttpHeaders.CACHE_CONTROL, "private, no-store");
  }

  public WorkspaceStoredFileView deleteWorkspacePath(String organizationId, String path) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    String relative = requireRelativePath(path, false);
    Map<String, Object> payload = runtime.runWorkspaceCommand(
        agent,
        "workspace.delete",
        Map.of("path", relative),
        WORKSPACE_COMMAND_TIMEOUT);
    String deleted = String.valueOf(payload.getOrDefault("path", relative));
    storage.delete(WorkspaceObjectKeys.objectKey(context.organizationId(), agent.getId(), deleted));
    return new WorkspaceStoredFileView(deleted, 0, "", fileName(deleted));
  }

  public WorkspaceStoredFileView createWorkspaceDirectory(String organizationId, WorkspaceDirectoryRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    Map<String, Object> payload = runtime.runWorkspaceCommand(
        agent,
        "workspace.mkdir",
        Map.of("path", requireRelativePath(Optional.ofNullable(request).map(WorkspaceDirectoryRequest::path).orElse(""), false)),
        WORKSPACE_COMMAND_TIMEOUT);
    String created = String.valueOf(payload.getOrDefault("path", ""));
    return new WorkspaceStoredFileView(created, 0, "inode/directory", fileName(created));
  }

  private static String requireRelativePath(String raw, boolean allowDot) {
    String value = Optional.ofNullable(raw).orElse("").trim().replace('\\', '/');
    if (value.isEmpty()) {
      value = ".";
    }
    if (value.startsWith("/") || value.contains("://")) {
      throw ApiException.invalidRequest("Invalid workspace path");
    }
    Path path = Path.of(value).normalize();
    if (path.isAbsolute()) {
      throw ApiException.invalidRequest("Invalid workspace path");
    }
    for (Path part : path) {
      if ("..".equals(part.toString())) {
        throw ApiException.invalidRequest("Invalid workspace path");
      }
    }
    String rendered = path.toString().replace('\\', '/');
    if (rendered.isEmpty()) {
      rendered = ".";
    }
    if (rendered.equals(".staging") || rendered.startsWith(".staging/")) {
      throw ApiException.invalidRequest("Invalid workspace path");
    }
    if (!allowDot && ".".equals(rendered)) {
      throw ApiException.invalidRequest("Invalid workspace path");
    }
    return rendered;
  }

  private Instant signedExpiry() {
    return Instant.now().plus(properties.getS3().getPresignTtl());
  }

  private ObjectStorage.SignedUrl publicFileUrl(
      String key, String filename, String mimeType, boolean inline, Instant expiresAt) {
    String disposition = ContentDisposition.builder(inline ? "inline" : "attachment")
        .filename(filename, StandardCharsets.UTF_8)
        .build()
        .toString();
    return storage.presignGet(key, ObjectStorage.Audience.PUBLIC, expiresAt, mimeType, disposition);
  }

  private static void requireFileSize(long size) {
    if (size < 0 || size > MAX_WORKSPACE_FILE_BYTES) {
      throw ApiException.invalidRequest("File is too large");
    }
  }

  private static String requireMimeType(String mimeType) {
    return Optional.ofNullable(mimeType).map(String::trim).filter(value -> !value.isBlank())
        .orElse("application/octet-stream");
  }

  private static String fileName(String raw) {
    String value = Optional.ofNullable(raw).orElse("").trim().replace('\\', '/');
    Path named = Path.of(value);
    String name = Optional.ofNullable(named.getFileName()).map(Path::toString).orElse("");
    if (name.isBlank() || ".".equals(name) || "..".equals(name)) {
      throw ApiException.invalidRequest("Invalid file name");
    }
    return name;
  }

  private static long numberValue(Object value, long fallback) {
    if (value instanceof Number number) {
      return number.longValue();
    }
    return fallback;
  }

  private static String downloadContentType(String filename) {
    String lower = filename.toLowerCase(java.util.Locale.ROOT);
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain; charset=utf-8";
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".pdf")) return "application/pdf";
    return "application/octet-stream";
  }

  public List<SkillView> listSkills(String organizationId) {
    return skills.listInstalledSkills(organizationId).stream()
        .map(row -> new SkillView(
            row.getId(), row.getName(), row.getDescription(), row.getCategory(), row.getIcon(),
            row.getLaunchMode(), row.getStarterPrompt(), row.getRevision()))
        .toList();
  }

  public List<MemoryView> listMemories(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    runtime.ensure(context);
    return memories.list(context);
  }

  public MemoryView createMemory(String organizationId, CreateMemoryRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    return memories.create(context, runtime.ensure(context), request);
  }

  public MemoryView patchMemory(String organizationId, String memoryId, PatchMemoryRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    return memories.patch(context, runtime.ensure(context), memoryId, request);
  }

  public void forgetMemory(String organizationId, String memoryId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    memories.forget(context, runtime.ensure(context), memoryId);
  }

  public MemoryView rememberMemory(String organizationId, RememberMemoryRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    return memories.remember(context, runtime.ensure(context), request);
  }

  public UsageCounts usageCounts(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AUDIT_READ);
    return Optional.ofNullable(agents.usageCounts(context.organizationId())).orElseGet(UsageCounts::new);
  }

  public List<AgentRuntimeRow> listRuntimes(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AUDIT_READ);
    return agents.listRuntimes(context.organizationId());
  }

  public SseEmitter subscribe(String organizationId, String conversationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = runtime.ensure(context);
    runtime.requireConversation(context, agent, conversationId);
    return channelEvents.subscribe(conversationId);
  }
}
