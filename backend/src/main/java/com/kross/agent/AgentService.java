package com.kross.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.dto.AgentProtocol;
import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.AgentModelView;
import com.kross.agent.dto.AgentViews;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.CloneWorkspaceRequest;
import com.kross.agent.dto.CloneWorkspaceView;
import com.kross.agent.dto.ConversationView;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.GitStatusView;
import com.kross.agent.dto.PatchConversationRequest;
import com.kross.agent.dto.ResolveToolApprovalRequest;
import com.kross.agent.dto.WorkspaceListingView;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;
import com.kross.agent.entity.AgentSession;
import com.kross.api.ApiException;
import com.kross.catalog.CredentialVault;
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
import com.kross.support.Tokens;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
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

  private final AgentMapper agents;
  private final OrganizationAccess access;
  private final ContainerBackend containers;
  private final CredentialVault vault;
  private final KrossProperties properties;
  private final ChannelEventBus channelEvents;
  private final AgentSocketHub sockets;
  private final ObjectMapper mapper;
  private final PlatformTransactionManager transactionManager;

  public AgentModelView currentModel(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    return agents.findUsableModel(context.organizationId()).map(AgentViews::model).orElse(null);
  }

  public List<AgentModelView> listModels(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    return agents.listUsableModels(context.organizationId()).stream()
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
    return AgentViews.conversation(insertConversation(context.organizationId(), agent, request.title()));
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
    Optional.ofNullable(request.mode()).ifPresent(mode -> conversation.setMode(normalizeMode(mode)));
    Optional.ofNullable(request.modelId()).ifPresent(modelId -> {
      String trimmed = modelId.trim();
      if (trimmed.isEmpty()) {
        conversation.setModelId(null);
      } else {
        conversation.setModelId(requireUsableModel(context.organizationId(), trimmed).getId());
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
    emitUpsert(row);
    RequestLogContext.put(RequestLogContext.CONVERSATION_ID, conversation.getId());
    RequestLogContext.bindAgent(agent);
    Agent toWake = agent;
    afterCommit(() -> {
      try {
        wake(toWake);
      } catch (RuntimeException error) {
        log.warn("Failed to wake agent {}: {}", toWake.getId(), error.getMessage());
      }
      offerJobToWorker(toWake.getId());
    });
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

  public void resolveApproval(
      String organizationId,
      String conversationId,
      String approvalId,
      ResolveToolApprovalRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = ensure(context);
    requireConversation(context, agent, conversationId);
    if (approvalId == null || approvalId.isBlank()) {
      throw ApiException.invalidRequest("approvalId is required");
    }
    sockets.send(agent.getId(), new AgentProtocol.ApprovalDecision(
        approvalId,
        request.approved(),
        Optional.ofNullable(request.reason()).map(String::trim).filter(value -> !value.isEmpty()).orElse(null)));
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

  public GitStatusView gitStatus(String organizationId, String path) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = ensure(context);
    Map<String, Object> payload = runWorkspaceCommand(
        agent,
        "git.status",
        Map.of("path", Optional.ofNullable(path).orElse(".")),
        Duration.ofSeconds(30));
    GitStatusView view = mapper.convertValue(payload, GitStatusView.class);
    return new GitStatusView(
        view.path(),
        view.repository(),
        view.branch(),
        view.dirty(),
        Optional.ofNullable(view.files()).orElse(List.of()));
  }

  public CloneWorkspaceView cloneWorkspace(String organizationId, CloneWorkspaceRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    String url = Optional.ofNullable(request.url()).map(String::trim).filter(value -> !value.isEmpty())
        .orElseThrow(() -> ApiException.invalidRequest("Repository URL is required"));
    Agent agent = ensure(context);
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("url", url);
    Optional.ofNullable(request.directory()).map(String::trim).filter(value -> !value.isEmpty())
        .ifPresent(directory -> payload.put("directory", directory));
    Map<String, Object> result = runWorkspaceCommand(agent, "git.clone", payload, Duration.ofMinutes(3));
    return mapper.convertValue(result, CloneWorkspaceView.class);
  }

  public void sleepIdleAgents() {
    Instant idleBefore = Instant.now().minusMillis(properties.getAgent().getIdleMs());
    for (Agent agent : agents.listIdleRunning(idleBefore)) {
      try {
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
    agents.requeueInterruptedMessages(agent.getId());
    agent.setStatus("running");
    agent.setLastError(null);
    agent.setLastActiveAt(Instant.now());
    agents.updateRuntime(agent);
    log.info("Agent worker registered");
    return new AgentProtocol.Registered(
        2,
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
    boolean shouldSleep = idle && !agents.hasProcessing(agent.getId());
    return new AgentProtocol.HeartbeatAck(
        2,
        "agent.heartbeat_ack",
        AgentProtocol.messageId(),
        Instant.now(),
        agent.getId(),
        shouldSleep,
        (int) properties.getAgent().getHeartbeatIntervalMs());
  }

  @Transactional
  public Optional<AgentProtocol.Job> claimJob(String token) {
    AgentSession session = authenticate(token);
    Optional<AgentMessage> claimed = agents.claimJob(session.getAgentId());
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
          : agents.listHistory(conversationId, row.getId(), HISTORY_LIMIT).stream()
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
      String mode = Optional.ofNullable(conversation)
          .map(AgentConversation::getMode)
          .filter(value -> !value.isBlank())
          .map(AgentService::normalizeMode)
          .orElse("auto");
      String modelId = Optional.ofNullable(conversation)
          .map(AgentConversation::getModelId)
          .filter(value -> !value.isBlank())
          .flatMap(id -> agents.findUsableModelById(session.getOrganizationId(), id))
          .map(AgentModel::getId)
          .orElse(null);
      return new AgentProtocol.Job(
          row.getId(), conversationId, reply.getId(), row.getContent(), history, row.getCreatedAt(), mode, modelId);
    });
  }

  @Transactional
  public void postReply(String token, AgentProtocol.ReplyRequest request) {
    AgentSession session = authenticate(token);
    String userMessageId = Optional.ofNullable(request.userMessageId()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("userMessageId is required"));
    String status = Optional.ofNullable(request.status()).orElse("done");
    if (!List.of("processing", "done", "failed").contains(status)) {
      throw ApiException.invalidRequest("status must be processing, done, or failed");
    }
    JsonNode parts = MessageParts.copyOrEmpty(mapper, request.parts());
    String content = Optional.ofNullable(request.content()).orElse("").trim();
    if (content.isEmpty()) {
      content = MessageParts.textSnapshot(parts);
    }
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
    reply.setContent(body);
    reply.setParts(parts);
    reply.setStatus(status);
    reply.setErrorSummary(request.errorSummary());
    agents.updateMessageBody(reply);
    agents.completeMessage(userMessageId, status, request.errorSummary());
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

  public void ingestEvents(String token, AgentProtocol.StreamEventsRequest request) {
    AgentSession session = authenticate(token);
    String agentMessageId = Optional.ofNullable(request.agentMessageId()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("agentMessageId is required"));
    AgentMessage reply = agents.findMessage(session.getOrganizationId(), agentMessageId)
        .filter(row -> session.getAgentId().equals(row.getAgentId()))
        .orElseThrow(() -> ApiException.notFound("Message"));
    String conversationId = Optional.ofNullable(reply.getConversationId()).orElse("");
    RequestLogContext.put(RequestLogContext.AGENT_ID, session.getAgentId());
    RequestLogContext.put(RequestLogContext.ORGANIZATION_ID, session.getOrganizationId());
    RequestLogContext.put(RequestLogContext.CONVERSATION_ID, conversationId);
    List<AgentProtocol.StreamEvent> events = Optional.ofNullable(request.events()).orElse(List.of());
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
        session.getOrganizationId(),
        Optional.ofNullable(request).map(AgentProtocol.ModelEnvironmentRequest::modelId));
    String ciphertext = Optional.ofNullable(model.getSecretCiphertext()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.conflict(
            "model_credential_unavailable", "No usable model credential is configured"));
    return new AgentProtocol.ModelEnvironment(
        vault.modelEnvironment(model.getProvider(), model.getModel(), vault.decrypt(ciphertext)));
  }

  private Agent ensure(OrganizationContext context) {
    return ensure(context.organizationId(), context.userId());
  }

  private Agent ensure(String organizationId, String userId) {
    Optional<Agent> existing = agents.findByUser(organizationId, userId);
    if (existing.isPresent()) {
      Agent agent = existing.get();
      if (agents.listConversations(organizationId, agent.getId()).isEmpty()) {
        insertConversation(organizationId, agent, DEFAULT_TITLE);
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
    containers.ensureVolume(id);
    insertConversation(organizationId, row, DEFAULT_TITLE);
    return row;
  }

  private AgentConversation insertConversation(String organizationId, Agent agent, String title) {
    Instant now = Instant.now();
    AgentConversation row = new AgentConversation();
    row.setId(UUID.randomUUID().toString());
    row.setOrganizationId(organizationId);
    row.setAgentId(agent.getId());
    row.setTitle(clipTitle(Optional.ofNullable(title).orElse("").trim().isEmpty()
        ? DEFAULT_TITLE
        : title.trim()));
    row.setMode("auto");
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

  private AgentModel requireUsableModel(String organizationId, String modelId) {
    return agents.findUsableModelById(organizationId, modelId)
        .orElseThrow(() -> ApiException.invalidRequest("Model is not available"));
  }

  private AgentModel resolveUsableModel(String organizationId, Optional<String> modelId) {
    return modelId
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .map(id -> requireUsableModel(organizationId, id))
        .or(() -> agents.findUsableModel(organizationId))
        .orElseThrow(() -> ApiException.conflict(
            "model_credential_unavailable", "No usable model credential is configured"));
  }

  private static String normalizeMode(String value) {
    String mode = Optional.ofNullable(value).orElse("").trim().toLowerCase();
    if (!List.of("auto", "plan", "conductor").contains(mode)) {
      throw ApiException.invalidRequest("mode must be auto, plan or conductor");
    }
    return mode;
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
    containers.stop(agent.getId());
    agents.revokeTokens(agent.getId());
    agent.setStatus("stopped");
    agent.setLastError(null);
    agents.updateRuntime(agent);
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
