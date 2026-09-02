package com.kross.connector;

import com.kross.agent.AgentConversationService;
import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.ConversationView;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.ResolveToolApprovalRequest;
import com.kross.api.ApiException;
import com.kross.config.AppProperties;
import com.kross.connector.entity.ConnectorBinding;
import com.kross.connector.entity.ConnectorInbox;
import com.kross.connector.entity.ConnectorThread;
import com.kross.identity.Identity;
import com.kross.identity.IdentityContexts;
import com.kross.identity.IdentityDirectory;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.support.Ids;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class ConnectorGateway {
  public static final String FEISHU = "feishu";
  static final int MAX_INBOX_ATTEMPTS = 8;

  private final ConnectorMapper connectors;
  private final AgentConversationService conversations;
  private final IdentityDirectory directory;
  private final OrganizationAccess access;
  private final AppProperties properties;

  public Optional<ConnectorBinding> findBinding(String channel, String tenantId, String externalUserId) {
    return connectors.findBinding(channel, tenantId, externalUserId);
  }

  public Optional<ConnectorBinding> findBindingByUser(String channel, String userId, String organizationId) {
    return connectors.findBindingByUser(channel, userId, organizationId);
  }

  public Optional<ConnectorThread> findThread(String channel, String externalChatId) {
    return connectors.findThread(channel, externalChatId);
  }

  public Optional<ConnectorThread> findThreadByConversation(String conversationId) {
    return connectors.findThreadByConversation(conversationId);
  }

  public Optional<ConnectorBinding> bindingForThread(ConnectorThread thread) {
    return Optional.ofNullable(thread)
        .map(ConnectorThread::getBindingId)
        .flatMap(connectors::findBindingById);
  }

  @Transactional
  public ConnectorBinding bind(
      String channel,
      String tenantId,
      String externalUserId,
      String userId,
      String organizationId) {
    String normalizedChannel = requireChannel(channel);
    String tenant = requireToken(tenantId, "tenant");
    String external = requireToken(externalUserId, "external user");
    Ids.requireResourceId(userId, "Invalid user identifier");
    Identity identity = requireIdentity(userId);
    return runAs(identity, () -> {
      access.require(organizationId, OrganizationAction.AGENT_CHAT);
      Instant now = Instant.now();
      Optional<ConnectorBinding> existing = connectors.findBinding(normalizedChannel, tenant, external);
      if (existing.filter(row -> userId.equals(row.getUserId()) && organizationId.equals(row.getOrganizationId()))
          .isPresent()) {
        return existing.orElseThrow();
      }
      connectors.deleteBindingsByUser(normalizedChannel, userId);
      existing = connectors.findBinding(normalizedChannel, tenant, external);
      if (existing.isPresent()) {
        ConnectorBinding row = existing.get();
        connectors.deleteThreadsByBinding(row.getId());
        row.setUserId(userId);
        row.setOrganizationId(organizationId);
        row.setUpdatedAt(now);
        connectors.updateBinding(row);
        return row;
      }
      ConnectorBinding row = new ConnectorBinding();
      row.setId(UUID.randomUUID().toString());
      row.setChannel(normalizedChannel);
      row.setTenantId(tenant);
      row.setExternalUserId(external);
      row.setUserId(userId);
      row.setOrganizationId(organizationId);
      row.setCreatedAt(now);
      row.setUpdatedAt(now);
      connectors.insertBinding(row);
      return row;
    });
  }

  @Transactional
  public void unbind(String channel, String userId, String organizationId) {
    access.require(organizationId, OrganizationAction.AGENT_CHAT);
    connectors.findBindingByUser(requireChannel(channel), userId, organizationId)
        .map(ConnectorBinding::getId)
        .ifPresent(connectors::deleteBindingById);
  }

  @Transactional
  public void unbind(ConnectorBinding binding) {
    Optional.ofNullable(binding).map(ConnectorBinding::getId).ifPresent(connectors::deleteBindingById);
  }

  @Transactional
  public ConnectorThread attachThread(
      String channel, String externalChatId, String conversationId, String bindingId) {
    String normalizedChannel = requireChannel(channel);
    String chatId = requireToken(externalChatId, "chat");
    Ids.requireResourceId(conversationId, "Invalid conversation identifier");
    Instant now = Instant.now();
    Optional<ConnectorThread> existing = connectors.findThread(normalizedChannel, chatId);
    if (existing.isPresent()) {
      ConnectorThread row = existing.get();
      row.setConversationId(conversationId);
      row.setBindingId(bindingId);
      connectors.updateThreadConversation(row.getId(), conversationId, bindingId);
      return row;
    }
    ConnectorThread row = new ConnectorThread();
    row.setId(UUID.randomUUID().toString());
    row.setChannel(normalizedChannel);
    row.setExternalChatId(chatId);
    row.setConversationId(conversationId);
    row.setBindingId(bindingId);
    row.setCreatedAt(now);
    row.setUpdatedAt(now);
    connectors.insertThread(row);
    return row;
  }

  /**
   * Persist an inbound event. Returns empty when the (channel, eventId) pair
   * already exists so callers can acknowledge the webhook without reprocessing.
   */
  @Transactional
  public Optional<ConnectorInbox> acceptInbox(String channel, String eventId, String payload) {
    ConnectorInbox row = new ConnectorInbox();
    row.setId(UUID.randomUUID().toString());
    row.setChannel(requireChannel(channel));
    row.setEventId(requireToken(eventId, "event"));
    row.setPayload(Optional.ofNullable(payload).orElse(""));
    row.setStatus("pending");
    row.setCreatedAt(Instant.now());
    row.setUpdatedAt(row.getCreatedAt());
    if (connectors.insertInbox(row) == 0) {
      return Optional.empty();
    }
    return Optional.of(row);
  }

  @Transactional
  public Optional<ConnectorInbox> beginInbox(String id) {
    if (connectors.beginInbox(id) == 0) {
      return Optional.empty();
    }
    return connectors.findInbox(id);
  }

  @Transactional
  public Optional<ConnectorInbox> claimInbox() {
    return connectors.claimInbox(MAX_INBOX_ATTEMPTS);
  }

  @Transactional
  public void markInboxDone(String id) {
    connectors.markInboxDone(id);
  }

  @Transactional
  public void markInboxFailed(String id, String error) {
    ConnectorInbox row = connectors.findInbox(id).orElse(null);
    int attempts = Optional.ofNullable(row).map(ConnectorInbox::getAttempts).orElse(1);
    Instant next = Instant.now().plusSeconds(Math.min(60L, 5L * Math.max(attempts, 1)));
    String clipped = Optional.ofNullable(error).map(String::trim).filter(value -> !value.isEmpty())
        .map(value -> value.length() > 500 ? value.substring(0, 500) : value)
        .orElse("processing failed");
    connectors.markInboxFailed(id, clipped, next);
  }

  public Identity requireIdentity(String userId) {
    IdentityDirectory.CachedUser user = directory.findUser(userId);
    if (user == null || !"active".equals(user.status())) {
      throw new ApiException("unauthenticated", "Sign in required", 401);
    }
    return new Identity(user.id(), user.username(), user.displayName(), user.platformRole());
  }

  private <T> T runAs(Identity identity, Supplier<T> action) {
    return IdentityContexts.runAs(identity, action);
  }

  public ConversationView createConversation(Identity identity, String organizationId, String title) {
    return runAs(identity, () -> conversations.createConversation(
        organizationId, new CreateConversationRequest(title, null, null)));
  }

  public AgentMessageView appendMessage(
      Identity identity, String organizationId, String conversationId, String content) {
    return runAs(identity, () -> conversations.appendMessage(
        organizationId, conversationId, new AppendAgentMessageRequest(content)));
  }

  public void resolveApproval(
      Identity identity,
      String organizationId,
      String conversationId,
      String approvalId,
      boolean approved) {
    runAs(identity, () -> {
      conversations.resolveApproval(
          organizationId, conversationId, approvalId, new ResolveToolApprovalRequest(approved, null));
      return null;
    });
  }

  public String workbenchUrl(String conversationId) {
    String base = Optional.ofNullable(properties.getExternalBaseUrl()).orElse("").trim();
    if (base.endsWith("/")) {
      base = base.substring(0, base.length() - 1);
    }
    return base + "/?c=" + conversationId;
  }

  private static String requireChannel(String channel) {
    String value = Optional.ofNullable(channel).map(String::trim).orElse("");
    if (value.isEmpty() || value.length() > 32) {
      throw ApiException.invalidRequest("Invalid connector channel");
    }
    return value;
  }

  private static String requireToken(String value, String label) {
    String token = Optional.ofNullable(value).map(String::trim).orElse("");
    if (token.isEmpty() || token.length() > 128) {
      throw ApiException.invalidRequest("Invalid " + label);
    }
    return token;
  }
}
