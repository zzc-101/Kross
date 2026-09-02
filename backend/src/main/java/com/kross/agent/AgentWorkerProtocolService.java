package com.kross.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.dto.AgentProtocol;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;
import com.kross.agent.entity.AgentSession;
import com.kross.api.ApiException;
import com.kross.catalog.CredentialVault;
import com.kross.catalog.SkillCatalogService;
import com.kross.channel.AgentSocketHub;
import com.kross.channel.ChannelEvent;
import com.kross.channel.MessageParts;
import com.kross.channel.WorkerOfferBus;
import com.kross.config.AppProperties;
import com.kross.connector.ConversationOutlet;
import com.kross.connector.ConversationTurnEvent;
import com.kross.knowledge.KnowledgeMcpService;
import com.kross.observability.RequestLogContext;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
@RequiredArgsConstructor
public class AgentWorkerProtocolService {
  private static final int HISTORY_LIMIT = 40;

  private final AgentMapper agents;
  private final CredentialVault vault;
  private final AppProperties properties;
  private final AgentSocketHub sockets;
  private final WorkerOfferBus offers;
  private final ObjectMapper mapper;
  private final AgentMemoryService memories;
  private final SkillCatalogService skills;
  private final ModelCatalog models;
  private final KnowledgeMcpService knowledgeMcp;
  private final AgentRuntimeOps runtime;
  private final AgentTransactions transactions;
  private final AgentChannelPublisher channels;
  private final List<ConversationOutlet> outlets;

  public AgentProtocol.WorkerSettings workerSettings(String token) {
    AgentSession session = runtime.authenticate(token);
    Agent agent = runtime.requireAgent(session.getAgentId());
    JsonNode servers = runtime.loadMcpServers(agent.getId());
    Map<String, Object> map = mapper.convertValue(servers, new TypeReference<Map<String, Object>>() {});
    Map<String, Object> merged = new LinkedHashMap<>(Optional.ofNullable(map).orElse(Map.of()));
    knowledgeMcp.managedServer().ifPresent(server -> merged.put(KnowledgeMcpService.SERVER_ID, server));
    AgentMemoryService.MemoryFiles files = memories.renderFiles(agent.getOrganizationId(), agent.getUserId());
    return new AgentProtocol.WorkerSettings(merged, files.userMarkdown(), files.memoryMarkdown());
  }

  public AgentProtocol.Registered register(String token, AgentProtocol.RegisterRequest request) {
    AgentSession session = runtime.authenticate(token);
    AgentRuntimeOps.assertAgent(session, Optional.ofNullable(request.agentId()));
    Agent agent = runtime.requireAgent(session.getAgentId());
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
    AgentSession session = runtime.authenticate(token);
    AgentRuntimeOps.assertAgent(session, Optional.ofNullable(request.agentId()));
    Agent agent = runtime.requireAgent(session.getAgentId());
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
    AgentSession session = runtime.authenticate(token);
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
          .flatMap(existing -> runtime.reusePlaceholder(existing))
          .orElseGet(() -> runtime.insertPlaceholder(session, row));
      channels.emitUpsert(row);
      channels.emitUpsert(reply);
      AgentConversation conversation = conversationId.isBlank()
          ? null
          : agents.findConversation(session.getOrganizationId(), conversationId).orElse(null);
      String modelId = Optional.ofNullable(conversation)
          .map(AgentConversation::getModelId)
          .filter(value -> !value.isBlank())
          .map(models::findUsable)
          .map(ModelCatalog.UsableModel::id)
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
    AgentSession session = runtime.authenticate(token);
    String userMessageId = Optional.ofNullable(request.userMessageId()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("userMessageId is required"));
    String deliveryId = AgentRuntimeOps.requireProtocolId(request.deliveryId(), "deliveryId");
    String leaseId = AgentRuntimeOps.requireProtocolId(request.leaseId(), "leaseId");
    String status = Optional.ofNullable(request.status()).orElse("done");
    if (!List.of("processing", "done", "failed").contains(status)) {
      throw ApiException.invalidRequest("status must be processing, done, or failed");
    }
    WorkerPayloadValidator.validateReply(mapper, request);
    if (agents.recordDelivery(deliveryId, session.getAgentId(), userMessageId) == 0) {
      return;
    }
    runtime.requireActiveLease(session.getAgentId(), userMessageId, leaseId);
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
          AgentMessage created = runtime.placeholder(session, userMessage, UUID.randomUUID().toString());
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
    channels.emitUpsert(agents.findMessage(session.getOrganizationId(), userMessageId).orElse(userMessage));
    AgentMessage published = agents.findMessage(session.getOrganizationId(), reply.getId()).orElse(reply);
    channels.emitUpsert(published);
    notifyOutlets(session, published, status);
    if ("processing".equals(status)) {
      return;
    }
    String agentId = session.getAgentId();
    transactions.afterCommit(() -> {
      sockets.markIdle(agentId);
      offers.offer(agentId);
    });
  }

  @Transactional
  public void ingestEvents(String token, AgentProtocol.StreamEventsRequest request) {
    AgentSession session = runtime.authenticate(token);
    String userMessageId = Optional.ofNullable(request.userMessageId()).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("userMessageId is required"));
    String leaseId = AgentRuntimeOps.requireProtocolId(request.leaseId(), "leaseId");
    List<AgentProtocol.StreamEvent> events = WorkerPayloadValidator.validateEvents(mapper, request.events());
    runtime.requireActiveLease(session.getAgentId(), userMessageId, leaseId);
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
      channels.emit(ChannelEvent.of(event.type(), conversationId, reply.getId(), data));
    }
    agents.touch(session.getAgentId());
  }

  @Transactional
  public Optional<AgentProtocol.Job> claimIfIdle(String token) {
    AgentSession session = runtime.authenticate(token);
    if (agents.hasProcessing(session.getAgentId())) {
      return Optional.empty();
    }
    return claimJob(token);
  }

  public void sleepFromWorker(String token, AgentProtocol.SleepRequest request) {
    AgentSession session = runtime.authenticate(token);
    AgentRuntimeOps.assertAgent(session, Optional.ofNullable(request.agentId()));
    runtime.sleep(runtime.requireAgent(session.getAgentId()));
  }

  public AgentProtocol.ModelEnvironment modelEnvironment(String token, AgentProtocol.ModelEnvironmentRequest request) {
    AgentSession session = runtime.authenticate(token);
    AgentModel model = runtime.resolveUsableModel(
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

  public AgentSession requireAgentSession(String token) {
    return runtime.authenticate(token);
  }

  private void notifyOutlets(AgentSession session, AgentMessage reply, String status) {
    if (outlets == null || outlets.isEmpty()) {
      return;
    }
    ConversationTurnEvent.Kind kind = switch (status) {
      case "done" -> ConversationTurnEvent.Kind.COMPLETED;
      case "failed" -> ConversationTurnEvent.Kind.FAILED;
      case "processing" -> ConversationTurnEvent.Kind.APPROVAL_REQUIRED;
      default -> null;
    };
    if (kind == null) {
      return;
    }
    List<ConversationTurnEvent.Approval> approvals = pendingApprovals(reply.getParts());
    if (kind == ConversationTurnEvent.Kind.APPROVAL_REQUIRED && approvals.isEmpty()) {
      return;
    }
    Agent agent = runtime.requireAgent(session.getAgentId());
    ConversationTurnEvent event = new ConversationTurnEvent(
        reply.getConversationId(),
        session.getOrganizationId(),
        agent.getUserId(),
        kind,
        Optional.ofNullable(reply.getContent()).orElse(""),
        reply.getErrorSummary(),
        approvals);
    transactions.afterCommit(() -> {
      for (ConversationOutlet outlet : outlets) {
        try {
          outlet.onTurn(event);
        } catch (Exception error) {
          log.warn("Conversation outlet failed: {}", error.getMessage());
        }
      }
    });
  }

  private static List<ConversationTurnEvent.Approval> pendingApprovals(JsonNode parts) {
    if (parts == null || !parts.isArray()) {
      return List.of();
    }
    List<ConversationTurnEvent.Approval> approvals = new ArrayList<>();
    for (JsonNode part : parts) {
      if (!"approval-required".equals(part.path("status").asText())) {
        continue;
      }
      String id = part.path("approval").path("id").asText("").trim();
      if (id.isEmpty()) {
        continue;
      }
      approvals.add(new ConversationTurnEvent.Approval(
          id,
          part.path("name").asText(""),
          part.path("approval").path("reason").asText(""),
          part.path("approval").path("inputPreview").asText("")));
    }
    return List.copyOf(approvals);
  }
}
