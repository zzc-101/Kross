package com.kross.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
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
import com.kross.agent.dto.WorkspaceFileView;
import com.kross.agent.dto.WorkspaceListingView;
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
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.observability.RequestLogContext;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
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
    if (content.isEmpty()) {
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
    row.setParts(MessageParts.empty(mapper));
    row.setStatus("queued");
    row.setCreatedBy(context.userId());
    row.setCreatedAt(Instant.now());
    agents.insertMessage(row);
    if (AgentRuntimeOps.DEFAULT_TITLE.equals(conversation.getTitle())) {
      conversation.setTitle(AgentRuntimeOps.clipTitle(content));
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
        Duration.ofSeconds(30));
    return mapper.convertValue(payload, WorkspaceListingView.class);
  }

  public WorkspaceFileView readWorkspaceFile(String organizationId, String path) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    Agent agent = runtime.ensure(context);
    Map<String, Object> payload = runtime.runWorkspaceCommand(
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
