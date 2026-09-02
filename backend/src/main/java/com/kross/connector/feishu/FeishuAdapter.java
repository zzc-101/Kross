package com.kross.connector.feishu;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import com.kross.config.AppProperties;
import com.kross.connector.ConnectorBindCodes;
import com.kross.connector.ConnectorGateway;
import com.kross.connector.ConversationOutlet;
import com.kross.connector.ConversationTurnEvent;
import com.kross.connector.entity.ConnectorBinding;
import com.kross.connector.entity.ConnectorThread;
import com.kross.identity.Identity;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class FeishuAdapter implements ConversationOutlet {
  static final String BIND_PROMPT = "请先在工作台账户菜单生成绑定码，并把 6 位数字发给我。";
  static final String RECEIVED = "已收到，正在处理。";

  private final AppProperties properties;
  private final ObjectMapper mapper;
  private final ConnectorGateway gateway;
  private final ConnectorBindCodes bindCodes;
  private final FeishuClient client;

  public boolean ready() {
    return properties.getFeishu().isReady();
  }

  public JsonNode decode(byte[] raw) {
    JsonNode root = read(raw);
    if (root.hasNonNull("encrypt")) {
      String key = properties.getFeishu().getEncryptKey();
      if (key.isBlank()) {
        throw ApiException.invalidRequest("Feishu encrypt key is not configured");
      }
      return read(FeishuCrypto.decrypt(key, root.path("encrypt").asText()).getBytes(StandardCharsets.UTF_8));
    }
    return root;
  }

  public void verify(String timestamp, String nonce, String signature, byte[] raw, JsonNode payload) {
    AppProperties.Feishu feishu = properties.getFeishu();
    if (!feishu.getEncryptKey().isBlank()) {
      if (!FeishuCrypto.verify(timestamp, nonce, feishu.getEncryptKey(), raw, signature)) {
        throw new ApiException("unauthenticated", "Invalid Feishu signature", 401);
      }
      return;
    }
    String token = feishu.getVerificationToken();
    if (token.isBlank()) {
      throw new ApiException("unauthenticated", "Feishu verification is not configured", 401);
    }
    String provided = firstNonBlank(
        payload.path("token").asText(""),
        payload.path("header").path("token").asText(""));
    if (!token.equals(provided)) {
      throw new ApiException("unauthenticated", "Invalid Feishu token", 401);
    }
  }

  public Optional<String> challenge(JsonNode payload) {
    String challenge = payload.path("challenge").asText("");
    if ("url_verification".equals(payload.path("type").asText("")) && !challenge.isBlank()) {
      return Optional.of(challenge);
    }
    return Optional.empty();
  }

  public String eventId(JsonNode payload) {
    String eventId = firstNonBlank(
        payload.path("header").path("event_id").asText(""),
        payload.path("uuid").asText(""),
        payload.path("event_id").asText(""),
        payload.path("open_message_id").asText(""));
    if (eventId.isBlank()) {
      throw ApiException.invalidRequest("Feishu event id is missing");
    }
    return eventId.length() > 128 ? eventId.substring(0, 128) : eventId;
  }

  public void handlePayload(String payload) {
    handle(read(payload.getBytes(StandardCharsets.UTF_8)));
  }

  void handle(JsonNode payload) {
    if (challenge(payload).isPresent()) {
      return;
    }
    String type = eventType(payload);
    if ("im.message.receive_v1".equals(type)) {
      onMessage(payload);
      return;
    }
    if ("card.action.trigger".equals(type) || "card".equals(payload.path("type").asText(""))) {
      onCard(payload);
    }
  }

  @Override
  public void onTurn(ConversationTurnEvent event) {
    if (!ready() || event == null) {
      return;
    }
    Optional<ConnectorThread> thread = gateway.findThreadByConversation(event.conversationId());
    if (thread.isEmpty()) {
      return;
    }
    String chatId = thread.get().getExternalChatId();
    String link = gateway.workbenchUrl(event.conversationId());
    if (event.kind() == ConversationTurnEvent.Kind.APPROVAL_REQUIRED) {
      event.approvals().forEach(approval -> client.sendCard(
          "chat_id", chatId, approvalCard(event.conversationId(), approval)));
      return;
    }
    if (event.kind() == ConversationTurnEvent.Kind.FAILED) {
      String summary = Optional.ofNullable(event.errorSummary()).filter(value -> !value.isBlank())
          .orElse("任务失败");
      client.sendText("chat_id", chatId, summary + "\n\n在工作台查看: " + link);
      return;
    }
    String content = Optional.ofNullable(event.content()).orElse("").trim();
    if (content.isEmpty()) {
      content = "任务已完成。";
    }
    client.sendText("chat_id", chatId, clip(content, 1500) + "\n\n在工作台查看: " + link);
  }

  private void onMessage(JsonNode payload) {
    JsonNode event = payload.path("event");
    String chatType = event.path("message").path("chat_type").asText("");
    String messageType = event.path("message").path("message_type").asText("");
    String senderType = event.path("sender").path("sender_type").asText("");
    if (!"p2p".equals(chatType) || !"user".equals(senderType)) {
      return;
    }
    String chatId = event.path("message").path("chat_id").asText("");
    String tenantId = firstNonBlank(
        payload.path("header").path("tenant_key").asText(""),
        event.path("sender").path("tenant_key").asText(""),
        "default");
    String openId = event.path("sender").path("sender_id").path("open_id").asText("");
    if (chatId.isBlank() || openId.isBlank()) {
      return;
    }
    if (!"text".equals(messageType)) {
      reply(chatId, "请发送文字，或到工作台上传附件。");
      return;
    }
    String text = extractText(event.path("message").path("content").asText("")).trim();
    if (text.isEmpty()) {
      return;
    }
    Optional<ConnectorBinding> binding = gateway.findBinding(ConnectorGateway.FEISHU, tenantId, openId);
    if (text.matches("\\d{6}") && tryBind(tenantId, openId, chatId, text)) {
      return;
    }
    if (binding.isEmpty()) {
      reply(chatId, text.matches("\\d{6}") ? "绑定码无效或已过期，请在工作台重新生成。" : BIND_PROMPT);
      return;
    }
    if ("/unbind".equalsIgnoreCase(text) || "／unbind".equals(text)) {
      gateway.unbind(binding.get());
      reply(chatId, "已解除绑定。");
      return;
    }
    ConnectorBinding row = binding.get();
    Identity identity = gateway.requireIdentity(row.getUserId());
    if ("/new".equalsIgnoreCase(text) || "／new".equals(text)) {
      var conversation = gateway.createConversation(identity, row.getOrganizationId(), "飞书对话");
      gateway.attachThread(ConnectorGateway.FEISHU, chatId, conversation.id(), row.getId());
      reply(chatId, "已开启新对话。");
      return;
    }
    deliver(row, identity, chatId, text);
  }

  private boolean tryBind(String tenantId, String openId, String chatId, String code) {
    Optional<ConnectorBindCodes.BindingTarget> target = bindCodes.consume(ConnectorGateway.FEISHU, code);
    if (target.isEmpty()) {
      return false;
    }
    gateway.bind(
        ConnectorGateway.FEISHU, tenantId, openId, target.get().userId(), target.get().organizationId());
    reply(chatId, "已绑定。之后发给我的消息会进入你的工作台对话。发 /new 可开启新对话。");
    return true;
  }

  private void deliver(ConnectorBinding binding, Identity identity, String chatId, String text) {
    Optional<ConnectorThread> thread = gateway.findThread(ConnectorGateway.FEISHU, chatId);
    String conversationId = thread.map(ConnectorThread::getConversationId).orElse(null);
    if (conversationId != null) {
      try {
        gateway.appendMessage(identity, binding.getOrganizationId(), conversationId, text);
        reply(chatId, RECEIVED);
        return;
      } catch (ApiException error) {
        if (!"not_found".equals(error.getCode()) && !isArchived(error)) {
          throw error;
        }
      }
    }
    var conversation = gateway.createConversation(identity, binding.getOrganizationId(), text);
    gateway.attachThread(ConnectorGateway.FEISHU, chatId, conversation.id(), binding.getId());
    gateway.appendMessage(identity, binding.getOrganizationId(), conversation.id(), text);
    reply(chatId, RECEIVED);
  }

  private void onCard(JsonNode payload) {
    JsonNode event = payload.has("event") ? payload.path("event") : payload;
    String openId = firstNonBlank(
        event.path("operator").path("open_id").asText(""),
        payload.path("open_id").asText(""));
    String tenantId = firstNonBlank(
        payload.path("header").path("tenant_key").asText(""),
        payload.path("tenant_key").asText(""),
        "default");
    JsonNode value = event.path("action").path("value");
    String approvalId = value.path("approvalId").asText("");
    String conversationId = value.path("conversationId").asText("");
    boolean approved = value.path("approved").asBoolean(false)
        || "true".equalsIgnoreCase(value.path("approved").asText());
    if (openId.isBlank() || approvalId.isBlank() || conversationId.isBlank()) {
      return;
    }
    ConnectorThread thread = gateway.findThreadByConversation(conversationId).orElse(null);
    if (thread == null) {
      return;
    }
    ConnectorBinding binding = gateway.findBinding(ConnectorGateway.FEISHU, tenantId, openId)
        .or(() -> gateway.bindingForThread(thread))
        .orElse(null);
    if (binding == null || !openId.equals(binding.getExternalUserId())) {
      return;
    }
    Identity identity = gateway.requireIdentity(binding.getUserId());
    gateway.resolveApproval(identity, binding.getOrganizationId(), conversationId, approvalId, approved);
    client.sendText(
        "chat_id",
        thread.getExternalChatId(),
        approved ? "已确认，继续执行。" : "已拒绝该操作。");
  }

  private Map<String, Object> approvalCard(String conversationId, ConversationTurnEvent.Approval approval) {
    String reason = firstNonBlank(approval.reason(), approval.toolName(), "需要确认后才能继续");
    Map<String, Object> approve = button("同意", "primary", conversationId, approval.approvalId(), true);
    Map<String, Object> reject = button("拒绝", "danger", conversationId, approval.approvalId(), false);
    Map<String, Object> card = new LinkedHashMap<>();
    card.put("config", Map.of("wide_screen_mode", true));
    card.put("header", Map.of(
        "template", "orange",
        "title", Map.of("tag", "plain_text", "content", "需要确认")));
    card.put("elements", List.of(
        Map.of("tag", "div", "text", Map.of("tag", "lark_md", "content", clip(reason, 500))),
        Map.of("tag", "action", "actions", List.of(approve, reject))));
    return card;
  }

  private static Map<String, Object> button(
      String label, String type, String conversationId, String approvalId, boolean approved) {
    Map<String, Object> value = new LinkedHashMap<>();
    value.put("conversationId", conversationId);
    value.put("approvalId", approvalId);
    value.put("approved", Boolean.toString(approved));
    Map<String, Object> button = new LinkedHashMap<>();
    button.put("tag", "button");
    button.put("type", type);
    button.put("text", Map.of("tag", "plain_text", "content", label));
    button.put("value", value);
    return button;
  }

  private void reply(String chatId, String text) {
    client.sendText("chat_id", chatId, text);
  }

  private String extractText(String content) {
    if (content == null || content.isBlank()) {
      return "";
    }
    try {
      JsonNode node = mapper.readTree(content);
      String text = node.path("text").asText("");
      return text.replaceAll("<at[^>]*>[^<]*</at>", "").trim();
    } catch (Exception ignored) {
      return content;
    }
  }

  private JsonNode read(byte[] raw) {
    try {
      return mapper.readTree(raw == null || raw.length == 0 ? "{}".getBytes(StandardCharsets.UTF_8) : raw);
    } catch (Exception error) {
      throw ApiException.invalidRequest("Feishu payload must be JSON");
    }
  }

  private static String eventType(JsonNode payload) {
    return firstNonBlank(
        payload.path("header").path("event_type").asText(""),
        payload.path("event").path("type").asText(""),
        payload.path("type").asText(""));
  }

  private static boolean isArchived(ApiException error) {
    return Optional.ofNullable(error.getMessage()).orElse("").contains("Archived");
  }

  private static String clip(String text, int max) {
    String value = Optional.ofNullable(text).orElse("");
    return value.length() <= max ? value : value.substring(0, max) + "...";
  }

  private static String firstNonBlank(String... values) {
    for (String value : values) {
      if (value != null && !value.isBlank()) {
        return value;
      }
    }
    return "";
  }
}
