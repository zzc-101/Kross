package com.kross.connector.feishu;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.config.AppProperties;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Slf4j
@Component
public class FeishuClient {
  private final AppProperties properties;
  private final ObjectMapper mapper;
  private final HttpClient http;
  private volatile Token token;

  public FeishuClient(AppProperties properties, ObjectMapper mapper) {
    this.properties = properties;
    this.mapper = mapper;
    this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  }

  FeishuClient(AppProperties properties, ObjectMapper mapper, HttpClient http) {
    this.properties = properties;
    this.mapper = mapper;
    this.http = http;
  }

  public void sendText(String receiveIdType, String receiveId, String text) {
    send(receiveIdType, receiveId, "text", Map.of("text", Optional.ofNullable(text).orElse("")));
  }

  public void sendCard(String receiveIdType, String receiveId, Map<String, Object> card) {
    send(receiveIdType, receiveId, "interactive", card);
  }

  private void send(String receiveIdType, String receiveId, String msgType, Object content) {
    if (!properties.getFeishu().isReady()) {
      return;
    }
    try {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("receive_id", receiveId);
      body.put("msg_type", msgType);
      body.put("content", mapper.writeValueAsString(content));
      JsonNode response = post(
          "/open-apis/im/v1/messages?receive_id_type=" + receiveIdType,
          body,
          tenantToken());
      if (response.path("code").asInt(-1) != 0) {
        log.warn("Feishu send failed: {}", response.path("msg").asText("unknown"));
      }
    } catch (Exception error) {
      log.warn("Feishu send failed: {}", error.getMessage());
    }
  }

  private String tenantToken() throws Exception {
    Token cached = token;
    if (cached != null && cached.expiresAt().isAfter(Instant.now().plusSeconds(60))) {
      return cached.value();
    }
    AppProperties.Feishu feishu = properties.getFeishu();
    JsonNode response = post(
        "/open-apis/auth/v3/tenant_access_token/internal",
        Map.of("app_id", feishu.getAppId(), "app_secret", feishu.getAppSecret()),
        null);
    String value = response.path("tenant_access_token").asText("");
    if (value.isBlank()) {
      throw new IllegalStateException(response.path("msg").asText("tenant token missing"));
    }
    token = new Token(value, Instant.now().plusSeconds(Math.max(response.path("expire").asInt(7200) - 60, 60)));
    return value;
  }

  private JsonNode post(String path, Object body, String bearer) throws Exception {
    HttpRequest.Builder builder = HttpRequest.newBuilder()
        .uri(URI.create(trimBase(properties.getFeishu().getBaseUrl()) + path))
        .timeout(Duration.ofSeconds(10))
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)));
    Optional.ofNullable(bearer).filter(value -> !value.isBlank())
        .ifPresent(value -> builder.header("Authorization", "Bearer " + value));
    HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    return mapper.readTree(response.body());
  }

  private static String trimBase(String base) {
    String value = Optional.ofNullable(base).orElse("https://open.feishu.cn");
    return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
  }

  private record Token(String value, Instant expiresAt) {}
}
