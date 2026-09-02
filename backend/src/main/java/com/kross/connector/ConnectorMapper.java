package com.kross.connector;

import com.kross.connector.entity.ConnectorBinding;
import com.kross.connector.entity.ConnectorInbox;
import com.kross.connector.entity.ConnectorThread;
import java.time.Instant;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface ConnectorMapper {
  Optional<ConnectorBinding> findBinding(
      @Param("channel") String channel,
      @Param("tenantId") String tenantId,
      @Param("externalUserId") String externalUserId);

  Optional<ConnectorBinding> findBindingByUser(
      @Param("channel") String channel,
      @Param("userId") String userId,
      @Param("organizationId") String organizationId);

  Optional<ConnectorBinding> findBindingById(@Param("id") String id);

  void insertBinding(ConnectorBinding row);

  int updateBinding(ConnectorBinding row);

  int deleteBindingsByUser(@Param("channel") String channel, @Param("userId") String userId);

  int deleteBindingById(@Param("id") String id);

  Optional<ConnectorThread> findThread(
      @Param("channel") String channel, @Param("externalChatId") String externalChatId);

  Optional<ConnectorThread> findThreadByConversation(@Param("conversationId") String conversationId);

  void insertThread(ConnectorThread row);

  int updateThreadConversation(
      @Param("id") String id,
      @Param("conversationId") String conversationId,
      @Param("bindingId") String bindingId);

  int deleteThreadsByBinding(@Param("bindingId") String bindingId);

  int insertInbox(ConnectorInbox row);

  Optional<ConnectorInbox> findInbox(@Param("id") String id);

  Optional<ConnectorInbox> claimInbox(@Param("maxAttempts") int maxAttempts);

  int beginInbox(@Param("id") String id);

  int markInboxDone(@Param("id") String id);

  int markInboxFailed(
      @Param("id") String id,
      @Param("lastError") String lastError,
      @Param("nextAttemptAt") Instant nextAttemptAt);
}
