package com.kross.connector;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.kross.agent.AgentConversationService;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.config.AppProperties;
import com.kross.connector.entity.ConnectorBinding;
import com.kross.connector.entity.ConnectorInbox;
import com.kross.connector.entity.ConnectorThread;
import com.kross.identity.Identity;
import com.kross.identity.IdentityDirectory;
import com.kross.identity.OrganizationAccess;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

class ConnectorGatewayTest {
  private ConnectorMapper mapper;
  private AgentConversationService conversations;
  private IdentityDirectory directory;
  private ConnectorGateway gateway;

  @BeforeEach
  void setUp() {
    mapper = mock(ConnectorMapper.class);
    conversations = mock(AgentConversationService.class);
    directory = mock(IdentityDirectory.class);
    when(directory.activeOrganizationStatus("org-1")).thenReturn("active");
    when(directory.activeMembership("org-1", "user-1"))
        .thenReturn(new IdentityDirectory.MembershipGrant("mem-1", "member"));
    when(directory.findUser("user-1"))
        .thenReturn(new IdentityDirectory.CachedUser("user-1", "alice", "Alice", "user", "active"));
    gateway = new ConnectorGateway(
        mapper, conversations, directory, new OrganizationAccess(directory), new AppProperties());
    SecurityContextHolder.getContext().setAuthentication(
        new UsernamePasswordAuthenticationToken(new Identity("user-1", "alice", "Alice", "user"), null, List.of()));
  }

  @AfterEach
  void clear() {
    SecurityContextHolder.clearContext();
  }

  @Test
  void acceptInboxReturnsEmptyOnDuplicateEvent() {
    when(mapper.insertInbox(any(ConnectorInbox.class))).thenReturn(0);

    assertThat(gateway.acceptInbox("feishu", "evt-1", "{}")).isEmpty();
  }

  @Test
  void acceptInboxKeepsFirstDelivery() {
    when(mapper.insertInbox(any(ConnectorInbox.class))).thenReturn(1);

    Optional<ConnectorInbox> accepted = gateway.acceptInbox("feishu", "evt-1", "{}");

    assertThat(accepted).isPresent();
    assertThat(accepted.get().getEventId()).isEqualTo("evt-1");
    verify(mapper).insertInbox(any(ConnectorInbox.class));
  }

  @Test
  void appendMessageRunsAsBoundIdentity() {
    gateway.appendMessage(
        new Identity("user-1", "alice", "Alice", "user"),
        "org-1",
        "conv-1",
        "hello");

    verify(conversations).appendMessage(eq("org-1"), eq("conv-1"), eq(new AppendAgentMessageRequest("hello")));
  }

  @Test
  void workbenchUrlUsesExternalBase() {
    AppProperties properties = new AppProperties();
    properties.setExternalBaseUrl("https://work.example.com/");
    ConnectorGateway urls = new ConnectorGateway(
        mapper, conversations, directory, new OrganizationAccess(directory), properties);

    assertThat(urls.workbenchUrl("conv-1")).isEqualTo("https://work.example.com/?c=conv-1");
  }

  @Test
  void bindReplacesPreviousIdentityForTheSameUser() {
    when(mapper.findBinding("feishu", "tenant", "ou-1")).thenReturn(Optional.empty());

    gateway.bind("feishu", "tenant", "ou-1", "user-1", "org-1");

    verify(mapper).deleteBindingsByUser("feishu", "user-1");
    verify(mapper).insertBinding(any());
    verify(mapper, never()).updateBinding(any());
  }

  @Test
  void unbindOnlyDeletesTheBindingForTheCurrentOrganization() {
    ConnectorBinding row = new ConnectorBinding();
    row.setId("bind-1");
    when(mapper.findBindingByUser("feishu", "user-1", "org-1")).thenReturn(Optional.of(row));

    gateway.unbind("feishu", "user-1", "org-1");

    verify(mapper).deleteBindingById("bind-1");
    verify(mapper, never()).deleteBindingsByUser(any(), any());
  }

  @Test
  void attachThreadPersistsBindingIdWhenChatAlreadyMapped() {
    ConnectorThread existing = new ConnectorThread();
    existing.setId("thread-1");
    existing.setConversationId("conv-old");
    existing.setBindingId("bind-old");
    when(mapper.findThread("feishu", "oc-1")).thenReturn(Optional.of(existing));

    gateway.attachThread("feishu", "oc-1", "conv-1", "bind-1");

    verify(mapper).updateThreadConversation("thread-1", "conv-1", "bind-1");
    verify(mapper, never()).insertThread(any());
  }
}
