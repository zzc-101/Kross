package com.kross.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.dto.AgentProtocol;
import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.AgentModelView;
import com.kross.agent.dto.AgentViews;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.ConversationView;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.CreateMemoryRequest;
import com.kross.agent.dto.MemoryView;
import com.kross.agent.dto.PatchMemoryRequest;
import com.kross.agent.dto.RememberMemoryRequest;
import com.kross.agent.dto.PatchConversationRequest;
import com.kross.agent.dto.ResolveToolApprovalRequest;
import com.kross.agent.dto.SkillView;
import com.kross.agent.dto.WorkspaceFileView;
import com.kross.agent.dto.WorkspaceListingView;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;
import com.kross.agent.entity.AgentSession;
import com.kross.agent.entity.AgentSettings;
import com.kross.agent.entity.UsageCounts;
import com.kross.agent.entity.AgentRuntimeRow;
import com.kross.api.ApiException;
import com.kross.catalog.CredentialVault;
import com.kross.catalog.SkillCatalogService;
import com.kross.catalog.entity.PlatformSkill;
import com.kross.channel.AgentSocketHub;
import com.kross.channel.ChannelEvent;
import com.kross.channel.ChannelEventBus;
import com.kross.channel.MessageParts;
import com.kross.config.KrossProperties;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.orchestrator.AgentNames;
import com.kross.orchestrator.ContainerBackend;
import com.kross.orchestrator.ContainerBackend.BackendHandle;
import com.kross.observability.RequestLogContext;
import com.kross.orchestrator.ContainerBackend.ResourceLimits;
import com.kross.support.Jsons;
import com.kross.support.Tokens;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Slf4j
@Service
@RequiredArgsConstructor
public class AgentService {
  private static final int DEFAULT_MESSAGE_LIMIT = 100;
  private static final int MAX_MESSAGE_LIMIT = 500;
  private static final int HISTORY_LIMIT = 40;
  private static final int MAX_CONTENT_CHARS = 32_768;
  private static final int MAX_TITLE_CHARS = 80;
  private static final String DEFAULT_TITLE = "新对话";
  private static final int RUNTIME_LOCK_STRIPES = 64;

  private final AgentMapper agents;
  private final OrganizationAccess access;
  private final ContainerBackend containers;
  private final CredentialVault vault;
  private final KrossProperties properties;
  private final ChannelEventBus channelEvents;
  private final AgentSocketHub sockets;
  private final ObjectMapper mapper;
  private final PlatformTransactionManager transactionManager;
  private final AgentMemoryService memories;
  private final SkillCatalogService skills;
  private final ReentrantLock[] runtimeLocks = createLocks(RUNTIME_LOCK_STRIPES);

  public List<AgentModelView> listModels(String organizationId) {
    access.require(organizationId, OrganizationAction.AGENT_READ);
    return agents.listUsableModels().stream()
        .map(AgentViews::model)
        .toList();
  }

  public List<ConversationView> listConversations(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = ensure(context);
    wakeQuietly(agent);
    return agents.listConversations(context.organizationId(), agent.getId()).stream()
        .map(AgentViews::conversation)
        .toList();
  }

  @Transactional
  public ConversationView createConversation(String organizationId, CreateConversationRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = ensure(context);
    PlatformSkill skill = Optional.ofNullable(request.skillId())
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .map(value -> skills.findInstalledSkill(context.organizationId(), value)
            .orElseThrow(() -> ApiException.notFound("Installed Skill")))
        .orElse(null);
    String title = Optional.ofNullable(request.title()).map(String::trim).filter(value -> !value.isEmpty())
        .orElseGet(() -> skill == null ? DEFAULT_TITLE : skill.getName());
    return AgentViews.conversation(insertConversation(context.organizationId(), agent, title,
        skill == null ? null : skill.getId()));
  }

  @Transactional
  public ConversationView patchConversation(
      String organizationId, String conversationId, PatchConversationRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = ensure(context);
    AgentConversation conversation = requireConversation(context, agent, conversationId);
    Optional.ofNullable(request.title())
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .ifPresent(title -> conversation.setTitle(clipTitle(title)));
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
        conversation.setModelId(requireUsableModel(trimmed).getId());
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
    if (content.isEmpty()) {
      throw ApiException.invalidRequest("Message content is required");
    }
    if (content.length() > MAX_CONTENT_CHARS) {
      throw ApiException.invalidRequest("Message content is too long");
    }
    Agent agent = ensure(context);
    AgentConversation conversation = requireConversation(context, agent, conversationId);
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
    row.setParts(MessageParts.empty(mapper));
    row.setStatus("queued");
    row.setCreatedBy(context.userId());
    row.setCreatedAt(Instant.now());
    agents.insertMessage(row);
    if (DEFAULT_TITLE.equals(conversation.getTitle())) {
      conversation.setTitle(clipTitle(content));
      agents.updateConversation(conversation);
    }
    agents.touchConversation(conversation.getId());
    agents.touch(agent.getId());
    memories.captureRememberPhrase(context, agent, content);
    emitUpsert(row);
    RequestLogContext.put(RequestLogContext.CONVERSATION_ID, conversation.getId());
    RequestLogContext.bindAgent(agent);
    Agent toWake = agent;
    afterCommit(() -> Thread.ofVirtual().start(RequestLogContext.propagate(() -> {
      try {
        wake(toWake);
      } catch (RuntimeException error) {
        log.warn("Failed to wake agent {}: {}", toWake.getId(), error.getMessage());
      }
      offerJobToWorker(toWake.getId());
    })));
    return AgentViews.message(row);
  }

  public List<AgentMessageView> listMessages(
      String organizationId, String conversationId, Optional<Integer> limit) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = ensure(context);
    requireConversation(context, agent, conversationId);
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
    Agent agent = ensure(context);
    requireConversation(context, agent, conversationId);
    String normalizedApprovalId = requireProtocolId(approvalId, "approvalId");
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
    afterCommit(() -> sockets.sendRequired(agent.getId(), decision));
  }

  public WorkspaceListingView listWorkspace(String organizationId, String path) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = ensure(context);
    Map<String, Object> payload = runWorkspaceCommand(
        agent,
        "workspace.list",
        Map.of("path", Optional.ofNullable(path).orElse(".")),
        Duration.ofSeconds(30));
    return mapper.convertValue(payload, WorkspaceListingView.class);
  }

  public WorkspaceFileView readWorkspaceFile(String organizationId, String path) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = ensure(context);
    Map<String, Object> payload = runWorkspaceCommand(
        agent,
        "workspace.read",
        Map.of("path", path),
        Duration.ofSeconds(30));
    return mapper.convertValue(payload, WorkspaceFileView.class);
  }

  public List<SkillView> listSkills(String organizationId) {
    return skills.listInstalledSkills(organizationId).stream()
        .map(row -> new SkillView(
            row.getId(), row.getName(), row.getDescription(), row.getCategory(), row.getIcon(),
            row.getLaunchMode(), row.getStarterPrompt(), row.getRevision()))
        .toList();
  }

  public AgentProtocol.WorkerSettings workerSettings(String token) {
    AgentSession session = authenticate(token);
    Agent agent = requireAgent(session.getAgentId());
    JsonNode servers = loadMcpServers(agent.getId());
    Map<String, Object> map = mapper.convertValue(servers, new TypeReference<Map<String, Object>>() {});
    AgentMemoryService.MemoryFiles files = memories.renderFiles(agent.getOrganizationId(), agent.getUserId());
    return new AgentProtocol.WorkerSettings(
        Optional.ofNullable(map).orElse(Map.of()), files.userMarkdown(), files.memoryMarkdown());
  }

  public List<MemoryView> listMemories(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    ensure(context);
    return memories.list(context);
  }

  public MemoryView createMemory(String organizationId, CreateMemoryRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    return memories.create(context, ensure(context), request);
  }

  public MemoryView patchMemory(String organizationId, String memoryId, PatchMemoryRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    return memories.patch(context, ensure(context), memoryId, request);
  }

  public void forgetMemory(String organizationId, String memoryId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    memories.forget(context, ensure(context), memoryId);
  }

  public MemoryView rememberMemory(String organizationId, RememberMemoryRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    return memories.remember(context, ensure(context), request);
  }

  public UsageCounts usageCounts(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AUDIT_READ);
    return Optional.ofNullable(agents.usageCounts(context.organizationId())).orElseGet(UsageCounts::new);
  }

  public List<AgentRuntimeRow> listRuntimes(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AUDIT_READ);
    return agents.listRuntimes(context.organizationId());
  }

  public void sleepIdleAgents() {
    Instant idleBefore = Instant.now().minusMillis(properties.getAgent().getIdleMs());
    for (Agent agent : agents.listIdleRunning(idleBefore)) {
      try {
        if (sockets.isConnected(agent.getId()) && memories.hasPendingExtract(agent)) {
          memories.consolidateAsync(agent);
          continue;
        }
        sleep(agent);
      } catch (RuntimeException ignored) {
        // best-effort idle stop; next tick retries
      }
    }
  }

  public void reconcileRuntimeAgents() {
    for (Agent agent : agents.listRuntimeAgents()) {
      RequestLogContext.bindAgent(agent);
      Optional<ContainerBackend.BackendInspection> inspection = containers.inspect(agent.getId());
      if (inspection.filter(state -> "running".equals(state.state())).isPresent()) {
        BackendHandle handle = inspection.get().handle();
        tx().executeWithoutResult(status -> markRunning(agent, handle));
        continue;
      }
      if (stillStarting(agent)) {
        continue;
      }
      boolean shouldWake = Boolean.TRUE.equals(tx().execute(status -> {
        agents.requeueInterruptedMessages(agent.getId());
        agent.setStatus("stopped");
        agent.setContainerId(null);
        agent.setLastError("Agent worker exited unexpectedly");
        agents.updateRuntime(agent);
        return agents.hasQueued(agent.getId());
      }));
      if (!shouldWake) {
        continue;
      }
      try {
        wake(agent);
      } catch (RuntimeException error) {
        log.warn("Failed to wake agent after interrupt: {}", error.getMessage());
      }
    }
  }

  @Transactional
  public void recoverExpiredJobLeases() {
    List<String> recoveredAgents = agents.recoverExpiredLeases(
        Instant.now(), properties.getAgent().getJobMaxAttempts());
    if (!recoveredAgents.isEmpty()) {
      log.warn("Recovered expired job leases for {} agents", recoveredAgents.size());
      afterCommit(() -> recoveredAgents.forEach(this::offerJobToWorker));
    }
  }

  @Transactional
  public void cleanupDeliveryReceipts() {
    agents.deleteDeliveryReceiptsBefore(Instant.now().minus(Duration.ofDays(1)));
  }

  @Transactional
  public void releaseClaimedJob(String agentId, String messageId, String leaseId) {
    if (agents.releaseLeasedMessage(agentId, messageId, leaseId) == 1) {
      afterCommit(() -> offerJobToWorker(agentId));
    }
  }

  private boolean stillStarting(Agent agent) {
    if (!"starting".equals(agent.getStatus())) {
      return false;
    }
    Instant updated = Optional.ofNullable(agent.getUpdatedAt()).orElse(Instant.EPOCH);
    Duration grace = Duration.ofMillis(properties.getAgent().getStartTimeoutMs());
    return updated.isAfter(Instant.now().minus(grace));
  }

  private void markRunning(Agent agent, BackendHandle handle) {
    if (!"running".equals(agent.getStatus())
        || !handle.containerId().equals(agent.getContainerId())) {
      agent.setStatus("running");
      agent.setContainerId(handle.containerId());
      Optional.ofNullable(handle.nodeId()).filter(value -> !value.isBlank()).ifPresent(agent::setNodeId);
      agent.setLastError(null);
      agents.updateRuntime(agent);
    }
  }

  private TransactionTemplate tx() {
    return new TransactionTemplate(transactionManager);
  }

  public AgentProtocol.Registered register(String token, AgentProtocol.RegisterRequest request) {
    AgentSession session = authenticate(token);
    assertAgent(session, Optional.ofNullable(request.agentId()));
    Agent agent = requireAgent(session.getAgentId());
    RequestLogContext.bindAgent(agent);
    agent.setStatus("running");
    agent.setLastError(null);
    agent.setLastActiveAt(Instant.now());
    agents.updateRuntime(agent);
    log.info("Agent worker registered");
    return new AgentProtocol.Registered(
        3,
        "agent.registered",
        AgentProtocol.messageId(),
        Instant.now(),
        agent.getId(),
        (int) properties.getAgent().getHeartbeatIntervalMs(),
        properties.getAgent().getIdleMs());
  }

  public AgentProtocol.HeartbeatAck heartbeat(String token, AgentProtocol.HeartbeatRequest request) {
    AgentSession session = authenticate(token);
    assertAgent(session, Optional.ofNullable(request.agentId()));
    Agent agent = requireAgent(session.getAgentId());
    Instant idleBefore = Instant.now().minusMillis(properties.getAgent().getIdleMs());
    boolean idle = Optional.ofNullable(agent.getLastActiveAt()).orElse(Instant.EPOCH).isBefore(idleBefore);
    boolean canSleep = idle && !agents.hasProcessing(agent.getId());
    boolean shouldSleep = canSleep;
    boolean leaseValid = true;
    String jobId = Optional.ofNullable(request.jobId()).orElse("").trim();
    String leaseId = Optional.ofNullable(request.leaseId()).orElse("").trim();
    if (!jobId.isEmpty() || !leaseId.isEmpty()) {
      leaseValid = !jobId.isEmpty()
          && !leaseId.isEmpty()
          && agents.renewJobLease(
              agent.getId(),
              jobId,
              leaseId,
              Instant.now().plusMillis(properties.getAgent().getJobLeaseMs())) == 1;
    }
    if (canSleep && sockets.isConnected(agent.getId()) && memories.hasPendingExtract(agent)) {
      memories.consolidateAsync(agent);
      shouldSleep = false;
    }
    return new AgentProtocol.HeartbeatAck(
        3,
        "agent.heartbeat_ack",
        AgentProtocol.messageId(),
        Instant.now(),
        agent.getId(),
        shouldSleep,
        leaseValid,
        (int) properties.getAgent().getHeartbeatIntervalMs());
  }

  @Transactional
  public Optional<AgentProtocol.Job> claimJob(String token) {
    AgentSession session = authenticate(token);
    String leaseId = UUID.randomUUID().toString();
    Optional<AgentMessage> claimed = agents.claimJob(
        session.getAgentId(),
        leaseId,
        Instant.now().plusMillis(properties.getAgent().getJobLeaseMs()));
    claimed.ifPresent(row -> {
      agents.touch(session.getAgentId());
      RequestLogContext.put(RequestLogContext.AGENT_ID, session.getAgentId());
      RequestLogContext.put(RequestLogContext.ORGANIZATION_ID, session.getOrganizationId());
      RequestLogContext.put(RequestLogContext.CONVERSATION_ID, row.getConversationId());
    });
    return claimed.map(row -> {
      String conversationId = Optional.ofNullable(row.getConversationId()).orElse("");
      List<AgentProtocol.HistoryTurn> history = conversationId.isBlank()
          ? List.of()
          : agents.listHistory(session.getOrganizationId(), conversationId, row.getId(), HISTORY_LIMIT).stream()
              .map(item -> new AgentProtocol.HistoryTurn(item.getRole(), item.getContent()))
              .toList();
      AgentMessage reply = agents.findReplyTo(session.getOrganizationId(), row.getId())
          .filter(existing -> session.getAgentId().equals(existing.getAgentId()))
          .flatMap(existing -> reusePlaceholder(existing))
          .orElseGet(() -> insertPlaceholder(session, row));
      emitUpsert(row);
      emitUpsert(reply);
      AgentConversation conversation = conversationId.isBlank()
          ? null
          : agents.findConversation(session.getOrganizationId(), conversationId).orElse(null);
      String modelId = Optional.ofNullable(conversation)
          .map(AgentConversation::getModelId)
          .filter(value -> !value.isBlank())
          .flatMap(agents::findUsableModelById)
          .map(AgentModel::getId)
          .orElse(null);
      AgentProtocol.ActiveSkill activeSkill = Optional.ofNullable(conversation)
          .map(AgentConversation::getSkillId)
          .filter(value -> !value.isBlank())
          .flatMap(skillId -> skills.findInstalledSkill(session.getOrganizationId(), skillId))
          .map(skill -> new AgentProtocol.ActiveSkill(
              skill.getId(), skill.getName(), skill.getDescription(), skill.getContent(), skill.getRevision()))
          .orElse(null);
      return new AgentProtocol.Job(
          row.getId(), conversationId, reply.getId(), row.getContent(), history, row.getCreatedAt(), modelId,
          row.getLeaseId(), activeSkill);
    });
  }

  @Transactional
  public void postReply(String token, AgentProtocol.ReplyRequest request) {
    AgentSession session = authenticate(token);
    String userMessageId = Optional.ofNullable(request.userMessageId()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("userMessageId is required"));
    String deliveryId = requireProtocolId(request.deliveryId(), "deliveryId");
    String leaseId = requireProtocolId(request.leaseId(), "leaseId");
    String status = Optional.ofNullable(request.status()).orElse("done");
    if (!List.of("processing", "done", "failed").contains(status)) {
      throw ApiException.invalidRequest("status must be processing, done, or failed");
    }
    WorkerPayloadValidator.validateReply(mapper, request);
    if (agents.recordDelivery(deliveryId, session.getAgentId(), userMessageId) == 0) {
      return;
    }
    requireActiveLease(session.getAgentId(), userMessageId, leaseId);
    JsonNode parts = MessageParts.copyOrEmpty(mapper, request.parts());
    String content = Optional.ofNullable(request.content()).orElse("").trim();
    if (content.isEmpty()) {
      content = MessageParts.textSnapshot(parts);
    }
    WorkerPayloadValidator.validateContent(content);
    AgentMessage userMessage = agents.findMessage(session.getOrganizationId(), userMessageId)
        .filter(row -> session.getAgentId().equals(row.getAgentId()))
        .orElseThrow(() -> ApiException.notFound("Message"));
    String conversationId = Optional.ofNullable(userMessage.getConversationId())
        .orElseThrow(() -> ApiException.invalidRequest("Message is missing a conversation"));
    RequestLogContext.put(RequestLogContext.AGENT_ID, session.getAgentId());
    RequestLogContext.put(RequestLogContext.ORGANIZATION_ID, session.getOrganizationId());
    RequestLogContext.put(RequestLogContext.CONVERSATION_ID, conversationId);
    String body = content.isEmpty() && "failed".equals(status)
        ? Optional.ofNullable(request.errorSummary()).orElse("Agent turn failed")
        : content;
    AgentMessage reply = Optional.ofNullable(request.agentMessageId())
        .filter(value -> !value.isBlank())
        .flatMap(id -> agents.findMessage(session.getOrganizationId(), id))
        .or(() -> agents.findReplyTo(session.getOrganizationId(), userMessageId))
        .filter(row -> session.getAgentId().equals(row.getAgentId()))
        .orElseGet(() -> {
          AgentMessage created = placeholder(session, userMessage, UUID.randomUUID().toString());
          agents.insertMessage(created);
          return created;
        });
    if (!conversationId.equals(reply.getConversationId())
        || !userMessageId.equals(reply.getReplyTo())
        || !"agent".equals(reply.getRole())) {
      throw ApiException.invalidRequest("Agent reply does not belong to the claimed conversation");
    }
    if ("processing".equals(status)) {
      for (String approvalId : WorkerPayloadValidator.pendingApprovalIds(parts)) {
        agents.insertPendingApproval(
            session.getAgentId(),
            approvalId,
            session.getOrganizationId(),
            conversationId,
            userMessageId,
            reply.getId());
      }
    }
    reply.setContent(body);
    reply.setParts(parts);
    if (request.usage() != null && request.usage().isObject()) {
      reply.setUsage(request.usage());
    }
    if (request.contextUsage() != null && request.contextUsage().isObject()) {
      reply.setContextUsage(request.contextUsage());
    }
    reply.setStatus(status);
    reply.setErrorSummary(request.errorSummary());
    agents.updateMessageBody(reply);
    if (agents.completeLeasedMessage(userMessageId, leaseId, status, request.errorSummary()) != 1) {
      throw ApiException.conflict("job_lease_lost", "Agent job lease is no longer active");
    }
    agents.touchConversation(conversationId);
    agents.touch(session.getAgentId());
    emitUpsert(agents.findMessage(session.getOrganizationId(), userMessageId).orElse(userMessage));
    emitUpsert(agents.findMessage(session.getOrganizationId(), reply.getId()).orElse(reply));
    if ("processing".equals(status)) {
      return;
    }
    String agentId = session.getAgentId();
    afterCommit(() -> {
      sockets.markIdle(agentId);
      offerJobToWorker(agentId);
    });
  }

  @Transactional
  public void ingestEvents(String token, AgentProtocol.StreamEventsRequest request) {
    AgentSession session = authenticate(token);
    String userMessageId = Optional.ofNullable(request.userMessageId()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("userMessageId is required"));
    String leaseId = requireProtocolId(request.leaseId(), "leaseId");
    List<AgentProtocol.StreamEvent> events = WorkerPayloadValidator.validateEvents(mapper, request.events());
    requireActiveLease(session.getAgentId(), userMessageId, leaseId);
    String agentMessageId = Optional.ofNullable(request.agentMessageId()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("agentMessageId is required"));
    AgentMessage userMessage = agents.findMessage(session.getOrganizationId(), userMessageId)
        .filter(row -> session.getAgentId().equals(row.getAgentId()))
        .filter(row -> "user".equals(row.getRole()))
        .orElseThrow(() -> ApiException.notFound("Message"));
    AgentMessage reply = agents.findMessage(session.getOrganizationId(), agentMessageId)
        .filter(row -> session.getAgentId().equals(row.getAgentId()))
        .filter(row -> "agent".equals(row.getRole()))
        .filter(row -> userMessageId.equals(row.getReplyTo()))
        .filter(row -> Optional.ofNullable(userMessage.getConversationId()).orElse("")
            .equals(Optional.ofNullable(row.getConversationId()).orElse("")))
        .orElseThrow(() -> ApiException.notFound("Message"));
    String conversationId = Optional.ofNullable(reply.getConversationId()).orElse("");
    RequestLogContext.put(RequestLogContext.AGENT_ID, session.getAgentId());
    RequestLogContext.put(RequestLogContext.ORGANIZATION_ID, session.getOrganizationId());
    RequestLogContext.put(RequestLogContext.CONVERSATION_ID, conversationId);
    for (AgentProtocol.StreamEvent event : events) {
      if (event == null || event.type() == null || event.type().isBlank()) {
        continue;
      }
      Map<String, Object> data = new LinkedHashMap<>();
      if (event.text() != null) {
        data.put("text", event.text());
      }
      if (event.id() != null) {
        data.put("id", event.id());
      }
      if (event.name() != null) {
        data.put("name", event.name());
      }
      if (event.input() != null) {
        data.put("input", event.input());
      }
      if (event.content() != null) {
        data.put("content", event.content());
      }
      if (event.ok() != null) {
        data.put("ok", event.ok());
      }
      emit(ChannelEvent.of(event.type(), conversationId, reply.getId(), data));
    }
    agents.touch(session.getAgentId());
  }

  private void requireActiveLease(String agentId, String messageId, String leaseId) {
    if (!agents.hasActiveLease(agentId, messageId, leaseId)) {
      throw ApiException.conflict("job_lease_lost", "Agent job lease is no longer active");
    }
  }

  private static String requireProtocolId(String value, String label) {
    String normalized = Optional.ofNullable(value).orElse("").trim();
    if (normalized.isEmpty() || normalized.length() > 128) {
      throw ApiException.invalidRequest(label + " is required");
    }
    return normalized;
  }

  public SseEmitter subscribe(String organizationId, String conversationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = ensure(context);
    requireConversation(context, agent, conversationId);
    return channelEvents.subscribe(conversationId);
  }

  public void offerJobToWorker(String agentId) {
    sockets.offerJob(agentId);
  }

  public AgentSession requireAgentSession(String token) {
    return authenticate(token);
  }

  @Transactional
  public Optional<AgentProtocol.Job> claimIfIdle(String token) {
    AgentSession session = authenticate(token);
    if (agents.hasProcessing(session.getAgentId())) {
      return Optional.empty();
    }
    return claimJob(token);
  }

  public void sleepFromWorker(String token, AgentProtocol.SleepRequest request) {
    AgentSession session = authenticate(token);
    assertAgent(session, Optional.ofNullable(request.agentId()));
    sleep(requireAgent(session.getAgentId()));
  }

  public AgentProtocol.ModelEnvironment modelEnvironment(String token, AgentProtocol.ModelEnvironmentRequest request) {
    AgentSession session = authenticate(token);
    AgentModel model = resolveUsableModel(
        Optional.ofNullable(request).map(AgentProtocol.ModelEnvironmentRequest::modelId));
    String ciphertext = Optional.ofNullable(model.getSecretCiphertext()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.conflict(
            "model_credential_unavailable", "No usable model credential is configured"));
    Map<String, String> environment = new LinkedHashMap<>(
        vault.modelEnvironment(model.getProvider(), model.getModel(), vault.decrypt(ciphertext)));
    environment.put(
        "AGENT_CONTEXT_WINDOW",
        Integer.toString(model.getConfiguration().path("contextWindow").asInt(256_000)));
    return new AgentProtocol.ModelEnvironment(environment);
  }

  private Agent ensure(OrganizationContext context) {
    return ensure(context.organizationId(), context.userId());
  }

  private Agent ensure(String organizationId, String userId) {
    Optional<Agent> existing = agents.findByUser(organizationId, userId);
    if (existing.isPresent()) {
      Agent agent = existing.get();
      if (agents.listConversations(organizationId, agent.getId()).isEmpty()) {
        insertConversation(organizationId, agent, DEFAULT_TITLE, null);
      }
      return agent;
    }
    String id = UUID.randomUUID().toString();
    Agent row = new Agent();
    row.setId(id);
    row.setOrganizationId(organizationId);
    row.setUserId(userId);
    row.setStatus("stopped");
    row.setVolumeName(AgentNames.volume(id));
    row.setContainerName(AgentNames.container(id));
    row.setLastActiveAt(Instant.now());
    try {
      agents.insert(row);
    } catch (DuplicateKeyException error) {
      return agents.findByUser(organizationId, userId)
          .orElseThrow(() -> ApiException.conflict("agent_create_race", "Agent creation raced"));
    }
    withRuntimeLock(id, () -> containers.ensureVolume(id));
    insertConversation(organizationId, row, DEFAULT_TITLE, null);
    return row;
  }

  private AgentConversation insertConversation(String organizationId, Agent agent, String title, String skillId) {
    Instant now = Instant.now();
    AgentConversation row = new AgentConversation();
    row.setId(UUID.randomUUID().toString());
    row.setOrganizationId(organizationId);
    row.setAgentId(agent.getId());
    row.setTitle(clipTitle(Optional.ofNullable(title).orElse("").trim().isEmpty()
        ? DEFAULT_TITLE
        : title.trim()));
    row.setSkillId(skillId);
    row.setLastMessageAt(now);
    row.setCreatedAt(now);
    row.setUpdatedAt(now);
    agents.insertConversation(row);
    return row;
  }

  private AgentConversation requireConversation(
      OrganizationContext context, Agent agent, String conversationId) {
    AgentConversation conversation = agents.findConversation(context.organizationId(), conversationId)
        .orElseThrow(() -> ApiException.notFound("Conversation"));
    if (!agent.getId().equals(conversation.getAgentId())) {
      throw ApiException.notFound("Conversation");
    }
    return conversation;
  }

  private Map<String, Object> runWorkspaceCommand(
      Agent agent, String name, Map<String, Object> payload, Duration timeout) {
    ensureWorker(agent);
    return sockets.requestCommand(agent.getId(), name, payload, timeout);
  }

  private void ensureWorker(Agent agent) {
    if (sockets.isConnected(agent.getId())) {
      return;
    }
    wake(agent);
    Duration wait = Duration.ofMillis(Math.min(
        Math.max(properties.getAgent().getStartTimeoutMs(), 5_000L),
        60_000L));
    if (!sockets.awaitConnected(agent.getId(), wait)) {
      throw ApiException.conflict("agent_offline", "Agent worker is not connected");
    }
  }

  private AgentModel requireUsableModel(String modelId) {
    return agents.findUsableModelById(modelId)
        .orElseThrow(() -> ApiException.invalidRequest("Model is not available"));
  }

  private AgentModel resolveUsableModel(Optional<String> modelId) {
    return modelId
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .map(this::requireUsableModel)
        .or(agents::findUsableModel)
        .orElseThrow(() -> ApiException.conflict(
            "model_credential_unavailable", "No usable model credential is configured"));
  }

  private JsonNode loadMcpServers(String agentId) {
    return agents.findSettings(agentId)
        .map(AgentSettings::getMcpServers)
        .map(Jsons::objectOrEmpty)
        .orElseGet(() -> mapper.createObjectNode());
  }

  private static String clipTitle(String title) {
    String normalized = title.replaceAll("\\s+", " ").trim();
    if (normalized.isEmpty()) {
      return DEFAULT_TITLE;
    }
    return normalized.length() <= MAX_TITLE_CHARS
        ? normalized
        : normalized.substring(0, MAX_TITLE_CHARS);
  }

  public void scheduleWake(String organizationId) {
    try {
      OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
      RequestLogContext.put(RequestLogContext.ORGANIZATION_ID, context.organizationId());
      RequestLogContext.put(RequestLogContext.USER_ID, context.userId());
      Thread.ofVirtual().start(RequestLogContext.propagate(() -> wakeQuietly(ensure(context))));
    } catch (RuntimeException error) {
      log.warn("Failed to schedule agent wake: {}", error.getMessage());
    }
  }

  public void scheduleWakeFor(String organizationId, String userId) {
    RequestLogContext.put(RequestLogContext.ORGANIZATION_ID, organizationId);
    RequestLogContext.put(RequestLogContext.USER_ID, userId);
    Thread.ofVirtual().start(RequestLogContext.propagate(() -> {
      try {
        wakeQuietly(ensure(organizationId, userId));
      } catch (RuntimeException error) {
        log.warn("Failed to wake agent workspace: {}", error.getMessage());
      }
    }));
  }

  public void wakeWorkspaceQuietly(String organizationId) {
    try {
      OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
      wake(ensure(context));
    } catch (RuntimeException error) {
      log.warn("Failed to wake agent workspace: {}", error.getMessage());
    }
  }

  private void wakeQuietly(Agent agent) {
    try {
      wake(agent);
    } catch (RuntimeException error) {
      log.warn("Failed to wake agent {}: {}", agent.getId(), error.getMessage());
    }
  }

  private void wake(Agent agent) {
    withRuntimeLock(agent.getId(), () -> wakeLocked(agent));
  }

  private void wakeLocked(Agent agent) {
    RequestLogContext.bindAgent(agent);
    Optional<ContainerBackend.BackendInspection> inspection = containers.inspect(agent.getId());
    if (inspection.filter(state -> "running".equals(state.state())).isPresent()) {
      agent.setStatus("running");
      agent.setContainerId(inspection.get().handle().containerId());
      Optional.ofNullable(inspection.get().handle().nodeId()).filter(value -> !value.isBlank())
          .ifPresent(agent::setNodeId);
      agent.setLastError(null);
      agents.updateRuntime(agent);
      RequestLogContext.bindAgent(agent);
      log.info("Agent workspace already running");
      return;
    }
    String token = issueToken(agent);
    agent.setStatus("starting");
    agent.setLastError(null);
    agents.updateRuntime(agent);
    log.info("Starting agent workspace");
    try {
      KrossProperties.Agent settings = properties.getAgent();
      BackendHandle handle = containers.start(new ContainerBackend.StartRequest(
          agent.getId(),
          token,
          properties.getPublicBaseUrl(),
          new ResourceLimits(settings.getCpuMillis(), settings.getMemoryBytes(), settings.getMaxPids())));
      agent.setStatus("running");
      agent.setContainerId(handle.containerId());
      agent.setNodeId(Optional.ofNullable(handle.nodeId()).filter(value -> !value.isBlank()).orElse(agent.getNodeId()));
      agent.setLastActiveAt(Instant.now());
      agents.updateRuntime(agent);
      RequestLogContext.bindAgent(agent);
      log.info("Agent workspace started");
    } catch (ApiException error) {
      agent.setStatus("error");
      agent.setLastError(Optional.ofNullable(error.getMessage()).orElse("Failed to start agent container"));
      agents.updateRuntime(agent);
      throw error;
    } catch (RuntimeException error) {
      agent.setStatus("error");
      agent.setLastError(Optional.ofNullable(error.getMessage()).orElse("Failed to start agent container"));
      agents.updateRuntime(agent);
      throw new ApiException("agent_start_failed", "Failed to start the agent workspace", 500);
    }
  }

  private void sleep(Agent agent) {
    withRuntimeLock(agent.getId(), () -> {
      containers.stop(agent.getId());
      agents.revokeTokens(agent.getId());
      agent.setStatus("stopped");
      agent.setLastError(null);
      agents.updateRuntime(agent);
    });
  }

  private void withRuntimeLock(String agentId, Runnable action) {
    ReentrantLock lock = runtimeLocks[Math.floorMod(agentId.hashCode(), runtimeLocks.length)];
    lock.lock();
    try {
      action.run();
    } finally {
      lock.unlock();
    }
  }

  private static ReentrantLock[] createLocks(int count) {
    ReentrantLock[] locks = new ReentrantLock[count];
    for (int index = 0; index < count; index += 1) {
      locks[index] = new ReentrantLock();
    }
    return locks;
  }

  private String issueToken(Agent agent) {
    agents.revokeTokens(agent.getId());
    String token = Tokens.randomSecret();
    agents.insertToken(
        Tokens.sha256Hex(token),
        agent.getOrganizationId(),
        agent.getId(),
        Instant.now().plusMillis(properties.getAgent().getTokenTtlMs()));
    return token;
  }

  private AgentSession authenticate(String token) {
    String calculated = Tokens.sha256Hex(Optional.ofNullable(token).orElse(""));
    AgentSession session = agents.authenticateToken(calculated)
        .orElseThrow(() -> new ApiException("agent_unauthenticated", "Invalid or expired agent token", 401));
    if (!Tokens.hashEquals(calculated, session.getTokenHash())) {
      throw new ApiException("agent_unauthenticated", "Invalid or expired agent token", 401);
    }
    return session;
  }

  private static void assertAgent(AgentSession session, Optional<String> agentId) {
    if (agentId.filter(id -> !id.equals(session.getAgentId())).isPresent()) {
      throw new ApiException("agent_token_mismatch", "Message does not match the agent token binding", 401);
    }
  }

  private Agent requireAgent(String agentId) {
    return agents.findByIdOnly(agentId).orElseThrow(() -> ApiException.notFound("Agent"));
  }

  private AgentMessage insertPlaceholder(AgentSession session, AgentMessage userMessage) {
    AgentMessage reply = placeholder(session, userMessage, UUID.randomUUID().toString());
    agents.insertMessage(reply);
    return reply;
  }

  private Optional<AgentMessage> reusePlaceholder(AgentMessage existing) {
    String status = Optional.ofNullable(existing.getStatus()).orElse("");
    if ("done".equals(status)) {
      return Optional.empty();
    }
    if (!"processing".equals(status)
        || Optional.ofNullable(existing.getErrorSummary()).filter(value -> !value.isBlank()).isPresent()) {
      existing.setStatus("processing");
      existing.setErrorSummary(null);
      existing.setContent("");
      existing.setParts(MessageParts.empty(mapper));
      agents.updateMessageBody(existing);
    }
    return Optional.of(existing);
  }

  private AgentMessage placeholder(AgentSession session, AgentMessage userMessage, String id) {
    AgentMessage reply = new AgentMessage();
    reply.setId(id);
    reply.setOrganizationId(session.getOrganizationId());
    reply.setAgentId(session.getAgentId());
    reply.setConversationId(userMessage.getConversationId());
    reply.setReplyTo(userMessage.getId());
    reply.setRole("agent");
    reply.setContent("");
    reply.setParts(MessageParts.empty(mapper));
    reply.setStatus("processing");
    reply.setCreatedAt(Instant.now());
    return reply;
  }

  private void emitUpsert(AgentMessage row) {
    Map<String, Object> data = new LinkedHashMap<>();
    data.put("message", AgentViews.message(row));
    emit(ChannelEvent.of("message.upsert", row.getConversationId(), row.getId(), data));
  }

  private void emit(ChannelEvent event) {
    afterCommit(() -> channelEvents.publish(event));
  }

  private void afterCommit(Runnable action) {
    Runnable traced = RequestLogContext.propagate(action);
    if (TransactionSynchronizationManager.isActualTransactionActive()) {
      TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {
          traced.run();
        }
      });
      return;
    }
    traced.run();
  }
}
