package com.kross.agent;

import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.AgentProtocol;
import com.kross.agent.dto.AgentView;
import com.kross.agent.dto.AgentViews;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.ConversationView;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.PatchConversationRequest;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;
import com.kross.agent.entity.AgentSession;
import com.kross.api.ApiException;
import com.kross.catalog.CredentialVault;
import com.kross.config.KrossProperties;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.orchestrator.AgentNames;
import com.kross.orchestrator.ContainerBackend;
import com.kross.orchestrator.ContainerBackend.BackendHandle;
import com.kross.orchestrator.ContainerBackend.ResourceLimits;
import com.kross.support.Tokens;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

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

  public AgentView getMine(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    return AgentViews.agent(ensure(context));
  }

  public List<ConversationView> listConversations(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = ensure(context);
    return agents.listConversations(context.organizationId(), agent.getId()).stream()
        .map(AgentViews::conversation)
        .toList();
  }

  @Transactional
  public ConversationView createConversation(String organizationId, CreateConversationRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = ensure(context);
    return AgentViews.conversation(insertConversation(context, agent, request.title()));
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
    row.setStatus("queued");
    row.setCreatedBy(context.userId());
    agents.insertMessage(row);
    if (DEFAULT_TITLE.equals(conversation.getTitle())) {
      conversation.setTitle(clipTitle(content));
      agents.updateConversation(conversation);
    }
    agents.touchConversation(conversation.getId());
    agents.touch(agent.getId());
    wake(agent);
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

  public AgentView sleepMine(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = ensure(context);
    sleep(agent);
    return AgentViews.agent(
        agents.findById(context.organizationId(), agent.getId()).orElse(agent));
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

  public AgentProtocol.Registered register(String token, AgentProtocol.RegisterRequest request) {
    AgentSession session = authenticate(token);
    assertAgent(session, Optional.ofNullable(request.agentId()));
    Agent agent = requireAgent(session.getAgentId());
    agent.setStatus("running");
    agent.setLastError(null);
    agent.setLastActiveAt(Instant.now());
    agents.updateRuntime(agent);
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
    claimed.ifPresent(row -> agents.touch(session.getAgentId()));
    return claimed.map(row -> {
      String conversationId = Optional.ofNullable(row.getConversationId()).orElse("");
      List<AgentProtocol.HistoryTurn> history = conversationId.isBlank()
          ? List.of()
          : agents.listHistory(conversationId, row.getId(), HISTORY_LIMIT).stream()
              .map(item -> new AgentProtocol.HistoryTurn(item.getRole(), item.getContent()))
              .toList();
      return new AgentProtocol.Job(
          row.getId(), conversationId, row.getContent(), history, row.getCreatedAt());
    });
  }

  @Transactional
  public void postReply(String token, AgentProtocol.ReplyRequest request) {
    AgentSession session = authenticate(token);
    String userMessageId = Optional.ofNullable(request.userMessageId()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("userMessageId is required"));
    String status = Optional.ofNullable(request.status()).orElse("done");
    if (!List.of("done", "failed").contains(status)) {
      throw ApiException.invalidRequest("status must be done or failed");
    }
    String content = Optional.ofNullable(request.content()).orElse("").trim();
    AgentMessage userMessage = agents.findMessage(session.getOrganizationId(), userMessageId)
        .filter(row -> session.getAgentId().equals(row.getAgentId()))
        .orElseThrow(() -> ApiException.notFound("Message"));
    String conversationId = Optional.ofNullable(userMessage.getConversationId())
        .orElseThrow(() -> ApiException.invalidRequest("Message is missing a conversation"));
    AgentMessage reply = new AgentMessage();
    reply.setId(UUID.randomUUID().toString());
    reply.setOrganizationId(session.getOrganizationId());
    reply.setAgentId(session.getAgentId());
    reply.setConversationId(conversationId);
    reply.setRole("agent");
    reply.setContent(content.isEmpty() && "failed".equals(status)
        ? Optional.ofNullable(request.errorSummary()).orElse("Agent turn failed")
        : content);
    reply.setStatus(status);
    reply.setErrorSummary(request.errorSummary());
    agents.insertMessage(reply);
    agents.completeMessage(userMessageId, status, request.errorSummary());
    agents.touchConversation(conversationId);
    agents.touch(session.getAgentId());
  }

  public void sleepFromWorker(String token, AgentProtocol.SleepRequest request) {
    AgentSession session = authenticate(token);
    assertAgent(session, Optional.ofNullable(request.agentId()));
    sleep(requireAgent(session.getAgentId()));
  }

  public AgentProtocol.ModelEnvironment modelEnvironment(String token) {
    AgentSession session = authenticate(token);
    AgentModel model = agents.findUsableModel(session.getOrganizationId())
        .orElseThrow(() -> ApiException.conflict(
            "model_credential_unavailable", "No usable model credential is configured"));
    String ciphertext = Optional.ofNullable(model.getSecretCiphertext()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.conflict(
            "model_credential_unavailable", "No usable model credential is configured"));
    return new AgentProtocol.ModelEnvironment(
        vault.modelEnvironment(model.getProvider(), model.getModel(), vault.decrypt(ciphertext)));
  }

  private Agent ensure(OrganizationContext context) {
    Optional<Agent> existing = agents.findByUser(context.organizationId(), context.userId());
    if (existing.isPresent()) {
      Agent agent = existing.get();
      if (agents.listConversations(context.organizationId(), agent.getId()).isEmpty()) {
        insertConversation(context, agent, DEFAULT_TITLE);
      }
      return agent;
    }
    String id = UUID.randomUUID().toString();
    Agent row = new Agent();
    row.setId(id);
    row.setOrganizationId(context.organizationId());
    row.setUserId(context.userId());
    row.setStatus("stopped");
    row.setVolumeName(AgentNames.volume(id));
    row.setContainerName(AgentNames.container(id));
    row.setLastActiveAt(Instant.now());
    try {
      agents.insert(row);
    } catch (DuplicateKeyException error) {
      return agents.findByUser(context.organizationId(), context.userId())
          .orElseThrow(() -> ApiException.conflict("agent_create_race", "Agent creation raced"));
    }
    containers.ensureVolume(id);
    insertConversation(context, row, DEFAULT_TITLE);
    return row;
  }

  private AgentConversation insertConversation(OrganizationContext context, Agent agent, String title) {
    Instant now = Instant.now();
    AgentConversation row = new AgentConversation();
    row.setId(UUID.randomUUID().toString());
    row.setOrganizationId(context.organizationId());
    row.setAgentId(agent.getId());
    row.setTitle(clipTitle(Optional.ofNullable(title).orElse("").trim().isEmpty()
        ? DEFAULT_TITLE
        : title.trim()));
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

  private static String clipTitle(String title) {
    String normalized = title.replaceAll("\\s+", " ").trim();
    if (normalized.isEmpty()) {
      return DEFAULT_TITLE;
    }
    return normalized.length() <= MAX_TITLE_CHARS
        ? normalized
        : normalized.substring(0, MAX_TITLE_CHARS);
  }

  private void wake(Agent agent) {
    Optional<ContainerBackend.BackendInspection> inspection = containers.inspect(agent.getId());
    if (inspection.filter(state -> "running".equals(state.state())).isPresent()) {
      agent.setStatus("running");
      agent.setContainerId(inspection.get().handle().containerId());
      agent.setLastError(null);
      agents.updateRuntime(agent);
      return;
    }
    String token = issueToken(agent);
    agent.setStatus("starting");
    agent.setLastError(null);
    agents.updateRuntime(agent);
    try {
      KrossProperties.Agent settings = properties.getAgent();
      BackendHandle handle = containers.start(new ContainerBackend.StartRequest(
          agent.getId(),
          token,
          properties.getPublicBaseUrl(),
          new ResourceLimits(settings.getCpuMillis(), settings.getMemoryBytes(), settings.getMaxPids())));
      agent.setStatus("running");
      agent.setContainerId(handle.containerId());
      agent.setLastActiveAt(Instant.now());
      agents.updateRuntime(agent);
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
}
