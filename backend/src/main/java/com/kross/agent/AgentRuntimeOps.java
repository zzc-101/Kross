package com.kross.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;
import com.kross.agent.entity.AgentSession;
import com.kross.agent.entity.AgentSettings;
import com.kross.api.ApiException;
import com.kross.channel.AgentSocketHub;
import com.kross.channel.MessageParts;
import com.kross.config.KrossProperties;
import com.kross.identity.OrganizationContext;
import com.kross.observability.RequestLogContext;
import com.kross.orchestrator.AgentNames;
import com.kross.orchestrator.ContainerBackend;
import com.kross.orchestrator.ContainerBackend.BackendHandle;
import com.kross.orchestrator.ContainerBackend.ResourceLimits;
import com.kross.support.Jsons;
import com.kross.support.Tokens;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Slf4j
@Component
@RequiredArgsConstructor
class AgentRuntimeOps {
  static final int MAX_TITLE_CHARS = 80;
  static final String DEFAULT_TITLE = "新对话";
  private static final int RUNTIME_LOCK_STRIPES = 64;

  private final AgentMapper agents;
  private final ContainerBackend containers;
  private final KrossProperties properties;
  private final AgentSocketHub sockets;
  private final ObjectMapper mapper;
  private final PlatformTransactionManager transactionManager;
  private final AgentTokenDirectory tokenSessions;
  private final ModelCatalog models;
  private final ReentrantLock[] runtimeLocks = createLocks(RUNTIME_LOCK_STRIPES);

  Agent ensure(OrganizationContext context) {
    return ensure(context.organizationId(), context.userId());
  }

  Agent ensure(String organizationId, String userId) {
    Optional<Agent> existing = agents.findByUser(organizationId, userId);
    if (existing.isPresent()) {
      Agent agent = existing.get();
      if (agents.listConversations(organizationId, agent.getId()).isEmpty()) {
        insertConversation(organizationId, agent, DEFAULT_TITLE, null, null);
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
    insertConversation(organizationId, row, DEFAULT_TITLE, null, null);
    return row;
  }

  AgentConversation insertConversation(
      String organizationId, Agent agent, String title, String skillId, String modelId) {
    Instant now = Instant.now();
    AgentConversation row = new AgentConversation();
    row.setId(UUID.randomUUID().toString());
    row.setOrganizationId(organizationId);
    row.setAgentId(agent.getId());
    row.setTitle(clipTitle(Optional.ofNullable(title).orElse("").trim().isEmpty()
        ? DEFAULT_TITLE
        : title.trim()));
    row.setSkillId(skillId);
    row.setModelId(modelId);
    row.setLastMessageAt(now);
    row.setCreatedAt(now);
    row.setUpdatedAt(now);
    agents.insertConversation(row);
    return row;
  }

  AgentConversation requireConversation(
      OrganizationContext context, Agent agent, String conversationId) {
    AgentConversation conversation = agents.findConversation(context.organizationId(), conversationId)
        .orElseThrow(() -> ApiException.notFound("Conversation"));
    if (!agent.getId().equals(conversation.getAgentId())) {
      throw ApiException.notFound("Conversation");
    }
    return conversation;
  }

  Map<String, Object> runWorkspaceCommand(
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

  String requireUsableModelId(String modelId) {
    return Optional.ofNullable(models.findUsable(modelId))
        .map(ModelCatalog.UsableModel::id)
        .orElseThrow(() -> ApiException.invalidRequest("Model is not available"));
  }

  AgentModel resolveUsableModel(Optional<String> modelId) {
    String requested = modelId.map(String::trim).filter(value -> !value.isEmpty()).orElse(null);
    String resolved = requested != null && models.findUsable(requested) != null
        ? requested
        : models.defaultModelId().orElse(null);
    if (resolved == null) {
      throw ApiException.conflict(
          "model_credential_unavailable", "No usable model credential is configured");
    }
    return agents.findUsableModelById(resolved)
        .orElseThrow(() -> ApiException.conflict(
            "model_credential_unavailable", "No usable model credential is configured"));
  }

  JsonNode loadMcpServers(String agentId) {
    return agents.findSettings(agentId)
        .map(AgentSettings::getMcpServers)
        .map(Jsons::objectOrEmpty)
        .orElseGet(() -> mapper.createObjectNode());
  }

  static String clipTitle(String title) {
    String normalized = title.replaceAll("\\s+", " ").trim();
    if (normalized.isEmpty()) {
      return DEFAULT_TITLE;
    }
    return normalized.length() <= MAX_TITLE_CHARS
        ? normalized
        : normalized.substring(0, MAX_TITLE_CHARS);
  }

  void wakeQuietly(Agent agent) {
    try {
      wake(agent);
    } catch (RuntimeException error) {
      log.warn("Failed to wake agent {}: {}", agent.getId(), error.getMessage());
    }
  }

  void wake(Agent agent) {
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
          new ResourceLimits(settings.getCpuMillis(), settings.getMemoryBytes(), settings.getMaxPids()),
          Optional.ofNullable(agent.getNodeId()).filter(value -> !value.isBlank())));
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

  void sleep(Agent agent) {
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

  AgentSession authenticate(String token) {
    String calculated = Tokens.sha256Hex(Optional.ofNullable(token).orElse(""));
    AgentSession session = tokenSessions.findSession(calculated);
    if (session == null || !Tokens.hashEquals(calculated, session.getTokenHash())) {
      throw new ApiException("agent_unauthenticated", "Invalid or expired agent token", 401);
    }
    return session;
  }

  static void assertAgent(AgentSession session, Optional<String> agentId) {
    if (agentId.filter(id -> !id.equals(session.getAgentId())).isPresent()) {
      throw new ApiException("agent_token_mismatch", "Message does not match the agent token binding", 401);
    }
  }

  Agent requireAgent(String agentId) {
    return agents.findByIdOnly(agentId).orElseThrow(() -> ApiException.notFound("Agent"));
  }

  AgentMessage insertPlaceholder(AgentSession session, AgentMessage userMessage) {
    AgentMessage reply = placeholder(session, userMessage, UUID.randomUUID().toString());
    agents.insertMessage(reply);
    return reply;
  }

  Optional<AgentMessage> reusePlaceholder(AgentMessage existing) {
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

  AgentMessage placeholder(AgentSession session, AgentMessage userMessage, String id) {
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

  boolean stillStarting(Agent agent) {
    if (!"starting".equals(agent.getStatus())) {
      return false;
    }
    Instant updated = Optional.ofNullable(agent.getUpdatedAt()).orElse(Instant.EPOCH);
    Duration grace = Duration.ofMillis(properties.getAgent().getStartTimeoutMs());
    return updated.isAfter(Instant.now().minus(grace));
  }

  void markRunning(Agent agent, BackendHandle handle) {
    if (!"running".equals(agent.getStatus())
        || !handle.containerId().equals(agent.getContainerId())) {
      agent.setStatus("running");
      agent.setContainerId(handle.containerId());
      Optional.ofNullable(handle.nodeId()).filter(value -> !value.isBlank()).ifPresent(agent::setNodeId);
      agent.setLastError(null);
      agents.updateRuntime(agent);
    }
  }

  TransactionTemplate tx() {
    return new TransactionTemplate(transactionManager);
  }

  static String requireProtocolId(String value, String label) {
    String normalized = Optional.ofNullable(value).orElse("").trim();
    if (normalized.isEmpty() || normalized.length() > 128) {
      throw ApiException.invalidRequest(label + " is required");
    }
    return normalized;
  }

  void requireActiveLease(String agentId, String messageId, String leaseId) {
    if (!agents.hasActiveLease(agentId, messageId, leaseId)) {
      throw ApiException.conflict("job_lease_lost", "Agent job lease is no longer active");
    }
  }
}
