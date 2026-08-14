package com.kross.agent;

import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentModel;
import com.kross.agent.entity.AgentSession;
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
      @Param("conversationId") String conversationId,
      @Param("excludeId") String excludeId,
      @Param("limit") int limit);

  Optional<AgentMessage> findMessage(
      @Param("organizationId") String organizationId, @Param("id") String id);

  Optional<AgentMessage> findReplyTo(
      @Param("organizationId") String organizationId, @Param("replyTo") String replyTo);

  Optional<AgentMessage> claimJob(@Param("agentId") String agentId);

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

  Optional<AgentModel> findUsableModel(@Param("organizationId") String organizationId);

  boolean hasProcessing(@Param("agentId") String agentId);
}
