package com.kross.agent;

import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;
import com.kross.agent.entity.AgentRuntimeRow;
import com.kross.agent.entity.AgentSession;
import com.kross.agent.entity.AgentSettings;
import com.kross.agent.entity.UsageCounts;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface AgentMapper {
  Optional<Agent> findByUser(
      @Param("organizationId") String organizationId, @Param("userId") String userId);

  Optional<Agent> findById(
      @Param("organizationId") String organizationId, @Param("id") String id);

  Optional<Agent> findByIdOnly(@Param("id") String id);

  List<Agent> listIdleRunning(@Param("idleBefore") Instant idleBefore);

  List<Agent> listRuntimeAgents();

  void insert(Agent row);

  int updateRuntime(Agent row);

  int touch(@Param("id") String id);

  void insertConversation(AgentConversation row);

  List<AgentConversation> listConversations(
      @Param("organizationId") String organizationId, @Param("agentId") String agentId);

  Optional<AgentConversation> findConversation(
      @Param("organizationId") String organizationId, @Param("id") String id);

  int updateConversation(AgentConversation row);

  int touchConversation(@Param("id") String id);

  void insertMessage(AgentMessage row);

  List<AgentMessage> listMessages(
      @Param("organizationId") String organizationId,
      @Param("conversationId") String conversationId,
      @Param("limit") int limit);

  List<AgentMessage> listHistory(
      @Param("organizationId") String organizationId,
      @Param("conversationId") String conversationId,
      @Param("excludeId") String excludeId,
      @Param("limit") int limit);

  Optional<AgentMessage> findMessage(
      @Param("organizationId") String organizationId, @Param("id") String id);

  Optional<AgentMessage> findReplyTo(
      @Param("organizationId") String organizationId, @Param("replyTo") String replyTo);

  Optional<AgentMessage> claimJob(
      @Param("agentId") String agentId,
      @Param("leaseId") String leaseId,
      @Param("leaseExpiresAt") Instant leaseExpiresAt);

  int renewJobLease(
      @Param("agentId") String agentId,
      @Param("messageId") String messageId,
      @Param("leaseId") String leaseId,
      @Param("leaseExpiresAt") Instant leaseExpiresAt);

  boolean hasActiveLease(
      @Param("agentId") String agentId,
      @Param("messageId") String messageId,
      @Param("leaseId") String leaseId);

  int completeLeasedMessage(
      @Param("id") String id,
      @Param("leaseId") String leaseId,
      @Param("status") String status,
      @Param("errorSummary") String errorSummary);

  int releaseLeasedMessage(
      @Param("agentId") String agentId,
      @Param("id") String id,
      @Param("leaseId") String leaseId);

  List<String> recoverExpiredLeases(
      @Param("now") Instant now,
      @Param("maxAttempts") int maxAttempts);

  int recordDelivery(
      @Param("deliveryId") String deliveryId,
      @Param("agentId") String agentId,
      @Param("messageId") String messageId);

  int deleteDeliveryReceiptsBefore(@Param("before") Instant before);

  int completeMessage(
      @Param("id") String id,
      @Param("status") String status,
      @Param("errorSummary") String errorSummary);

  int updateMessageBody(AgentMessage row);

  void insertToken(
      @Param("tokenHash") String tokenHash,
      @Param("organizationId") String organizationId,
      @Param("agentId") String agentId,
      @Param("expiresAt") Instant expiresAt);

  int revokeTokens(@Param("agentId") String agentId);

  Optional<AgentSession> authenticateToken(@Param("tokenHash") String tokenHash);

  Optional<AgentModel> findUsableModel();

  List<AgentModel> listUsableModels();

  Optional<AgentModel> findUsableModelById(@Param("id") String id);

  boolean hasProcessing(@Param("agentId") String agentId);

  boolean hasQueued(@Param("agentId") String agentId);

  int requeueInterruptedMessages(@Param("agentId") String agentId);

  Optional<AgentSettings> findSettings(@Param("agentId") String agentId);

  void upsertSettings(AgentSettings row);

  void touchMemoryExtracted(
      @Param("agentId") String agentId,
      @Param("organizationId") String organizationId,
      @Param("extractedAt") Instant extractedAt);

  List<AgentMessage> listUserMessagesSince(
      @Param("agentId") String agentId,
      @Param("since") Instant since,
      @Param("limit") int limit);

  List<AgentRuntimeRow> listRuntimes(@Param("organizationId") String organizationId);

  UsageCounts usageCounts(@Param("organizationId") String organizationId);
}
