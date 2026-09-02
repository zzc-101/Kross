package com.kross.connector.feishu;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.ConversationView;
import com.kross.api.ApiException;
import com.kross.config.AppProperties;
import com.kross.connector.ConnectorBindCodes;
import com.kross.connector.ConnectorGateway;
import com.kross.connector.ConversationTurnEvent;
import com.kross.connector.entity.ConnectorBinding;
import com.kross.connector.entity.ConnectorThread;
import com.kross.identity.Identity;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class FeishuAdapterTest {
  private ConnectorGateway gateway;
  private ConnectorBindCodes bindCodes;
  private FeishuClient client;
  private FeishuAdapter adapter;
  private Identity identity;

  @BeforeEach
  void setUp() {
    gateway = mock(ConnectorGateway.class);
    bindCodes = mock(ConnectorBindCodes.class);
    client = mock(FeishuClient.class);
    AppProperties properties = new AppProperties();
    properties.getFeishu().setEnabled(true);
    properties.getFeishu().setAppId("cli_1");
    properties.getFeishu().setAppSecret("secret");
    properties.getFeishu().setVerificationToken("verify");
    identity = new Identity("user-1", "alice", "Alice", "user");
    when(gateway.requireIdentity("user-1")).thenReturn(identity);
    adapter = new FeishuAdapter(properties, new ObjectMapper(), gateway, bindCodes, client);
  }

  @Test
  void challengeExtractsUrlVerification() throws Exception {
    assertThat(adapter.challenge(new ObjectMapper().readTree(
        "{\"type\":\"url_verification\",\"challenge\":\"c-1\",\"token\":\"verify\"}")))
        .contains("c-1");
  }

  @Test
  void challengeIgnoresPayloadsThatOnlyContainAChallengeField() throws Exception {
    assertThat(adapter.challenge(new ObjectMapper().readTree(
        "{\"challenge\":\"c-1\",\"event_id\":\"evt-1\"}")))
        .isEmpty();
  }

  @Test
  void eventIdDoesNotFallBackToVerificationToken() throws Exception {
    assertThatThrownBy(() -> adapter.eventId(new ObjectMapper().readTree(
        "{\"token\":\"verify\",\"event\":{}}")))
        .isInstanceOf(ApiException.class);
  }

  @Test
  void unboundUserGetsBindPromptAndDoesNotAppend() throws Exception {
    when(gateway.findBinding("feishu", "tenant", "ou-1")).thenReturn(Optional.empty());

    adapter.handle(new ObjectMapper().readTree("""
        {
          "header": {"event_type": "im.message.receive_v1", "tenant_key": "tenant"},
          "event": {
            "sender": {"sender_type": "user", "sender_id": {"open_id": "ou-1"}},
            "message": {
              "chat_id": "oc-1",
              "chat_type": "p2p",
              "message_type": "text",
              "content": "{\\"text\\":\\"hello\\"}"
            }
          }
        }
        """));

    verify(client).sendText("chat_id", "oc-1", FeishuAdapter.BIND_PROMPT);
    verify(gateway, never()).appendMessage(any(), any(), any(), any());
  }

  @Test
  void bindCodeCreatesBinding() throws Exception {
    when(bindCodes.consume("feishu", "123456"))
        .thenReturn(Optional.of(new ConnectorBindCodes.BindingTarget("user-1", "org-1")));

    adapter.handle(new ObjectMapper().readTree("""
        {
          "header": {"event_type": "im.message.receive_v1", "tenant_key": "tenant"},
          "event": {
            "sender": {"sender_type": "user", "sender_id": {"open_id": "ou-1"}},
            "message": {
              "chat_id": "oc-1",
              "chat_type": "p2p",
              "message_type": "text",
              "content": "{\\"text\\":\\"123456\\"}"
            }
          }
        }
        """));

    verify(gateway).bind("feishu", "tenant", "ou-1", "user-1", "org-1");
    verify(gateway, never()).appendMessage(any(), any(), any(), any());
  }

  @Test
  void boundSixDigitTextIsANormalMessageWhenCodeIsNotActive() throws Exception {
    ConnectorBinding binding = binding();
    when(gateway.findBinding("feishu", "tenant", "ou-1")).thenReturn(Optional.of(binding));
    when(bindCodes.consume("feishu", "123456")).thenReturn(Optional.empty());
    when(gateway.findThread("feishu", "oc-1")).thenReturn(Optional.empty());
    when(gateway.createConversation(identity, "org-1", "123456"))
        .thenReturn(new ConversationView("conv-1", "123456", null, null, null, Instant.parse("2026-09-02T00:00:00Z"),
            Instant.parse("2026-09-02T00:00:00Z")));
    when(gateway.appendMessage(identity, "org-1", "conv-1", "123456"))
        .thenReturn(new AgentMessageView(
            "msg-1", "conv-1", "user", "123456", null, null, "queued", null, Instant.parse("2026-09-02T00:00:00Z")));

    adapter.handle(new ObjectMapper().readTree("""
        {
          "header": {"event_type": "im.message.receive_v1", "tenant_key": "tenant"},
          "event": {
            "sender": {"sender_type": "user", "sender_id": {"open_id": "ou-1"}},
            "message": {
              "chat_id": "oc-1",
              "chat_type": "p2p",
              "message_type": "text",
              "content": "{\\"text\\":\\"123456\\"}"
            }
          }
        }
        """));

    verify(gateway, never()).bind(any(), any(), any(), any(), any());
    verify(gateway).appendMessage(identity, "org-1", "conv-1", "123456");
  }

  @Test
  void boundTextCreatesThreadThenAppends() throws Exception {
    ConnectorBinding binding = binding();
    when(gateway.findBinding("feishu", "tenant", "ou-1")).thenReturn(Optional.of(binding));
    when(gateway.findThread("feishu", "oc-1")).thenReturn(Optional.empty());
    when(gateway.createConversation(identity, "org-1", "整理周报"))
        .thenReturn(new ConversationView("conv-1", "整理周报", null, null, null, Instant.parse("2026-09-02T00:00:00Z"),
            Instant.parse("2026-09-02T00:00:00Z")));
    when(gateway.appendMessage(identity, "org-1", "conv-1", "整理周报"))
        .thenReturn(new AgentMessageView(
            "msg-1", "conv-1", "user", "整理周报", null, null, "queued", null, Instant.parse("2026-09-02T00:00:00Z")));

    adapter.handle(new ObjectMapper().readTree("""
        {
          "header": {"event_type": "im.message.receive_v1", "tenant_key": "tenant"},
          "event": {
            "sender": {"sender_type": "user", "sender_id": {"open_id": "ou-1"}},
            "message": {
              "chat_id": "oc-1",
              "chat_type": "p2p",
              "message_type": "text",
              "content": "{\\"text\\":\\"整理周报\\"}"
            }
          }
        }
        """));

    verify(gateway).attachThread("feishu", "oc-1", "conv-1", "bind-1");
    verify(gateway).appendMessage(identity, "org-1", "conv-1", "整理周报");
    verify(client).sendText("chat_id", "oc-1", FeishuAdapter.RECEIVED);
  }

  @Test
  void groupChatIsIgnored() throws Exception {
    adapter.handle(new ObjectMapper().readTree("""
        {
          "header": {"event_type": "im.message.receive_v1", "tenant_key": "tenant"},
          "event": {
            "sender": {"sender_type": "user", "sender_id": {"open_id": "ou-1"}},
            "message": {
              "chat_id": "oc-group",
              "chat_type": "group",
              "message_type": "text",
              "content": "{\\"text\\":\\"hello\\"}"
            }
          }
        }
        """));

    verify(gateway, never()).appendMessage(any(), any(), any(), any());
    verify(client, never()).sendText(any(), any(), any());
  }

  @Test
  void outletWithoutThreadIsNoOp() {
    when(gateway.findThreadByConversation("conv-1")).thenReturn(Optional.empty());

    adapter.onTurn(new ConversationTurnEvent(
        "conv-1", "org-1", "user-1", ConversationTurnEvent.Kind.COMPLETED, "done", null, List.of()));

    verify(client, never()).sendText(any(), any(), any());
  }

  @Test
  void completedTurnSendsSummaryToBoundChat() {
    ConnectorThread thread = new ConnectorThread();
    thread.setExternalChatId("oc-1");
    thread.setConversationId("conv-1");
    when(gateway.findThreadByConversation("conv-1")).thenReturn(Optional.of(thread));
    when(gateway.workbenchUrl("conv-1")).thenReturn("https://work.example.com/?c=conv-1");

    adapter.onTurn(new ConversationTurnEvent(
        "conv-1", "org-1", "user-1", ConversationTurnEvent.Kind.COMPLETED, "周报已写好", null, List.of()));

    verify(client).sendText("chat_id", "oc-1", "周报已写好\n\n在工作台查看: https://work.example.com/?c=conv-1");
  }

  private static ConnectorBinding binding() {
    ConnectorBinding row = new ConnectorBinding();
    row.setId("bind-1");
    row.setChannel("feishu");
    row.setTenantId("tenant");
    row.setExternalUserId("ou-1");
    row.setUserId("user-1");
    row.setOrganizationId("org-1");
    return row;
  }
}
