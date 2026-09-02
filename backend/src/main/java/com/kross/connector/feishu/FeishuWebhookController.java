package com.kross.connector.feishu;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.kross.api.ApiException;
import com.kross.config.AppProperties;
import com.kross.connector.ConnectorGateway;
import com.kross.connector.entity.ConnectorInbox;
import com.kross.observability.RequestLogContext;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/hooks/feishu")
public class FeishuWebhookController {
  private final AppProperties properties;
  private final ObjectMapper mapper;
  private final FeishuAdapter adapter;
  private final ConnectorGateway gateway;
  private final ConnectorInboxProcessor inbox;

  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<JsonNode> post(
      @RequestHeader(value = "X-Lark-Request-Timestamp", required = false) String timestamp,
      @RequestHeader(value = "X-Lark-Request-Nonce", required = false) String nonce,
      @RequestHeader(value = "X-Lark-Signature", required = false) String signature,
      @RequestBody(required = false) byte[] raw) {
    if (!properties.getFeishu().isReady()) {
      throw ApiException.notFound("Connector");
    }
    byte[] body = Optional.ofNullable(raw).orElseGet(() -> new byte[0]);
    JsonNode payload = adapter.decode(body);
    adapter.verify(timestamp, nonce, signature, body, payload);
    Optional<String> challenge = adapter.challenge(payload);
    if (challenge.isPresent()) {
      ObjectNode response = mapper.createObjectNode();
      response.put("challenge", challenge.get());
      return ResponseEntity.ok(response);
    }
    Optional<ConnectorInbox> accepted = gateway.acceptInbox(
        ConnectorGateway.FEISHU, adapter.eventId(payload), payload.toString());
    accepted.ifPresent(row ->
        Thread.ofVirtual().start(RequestLogContext.propagate(() -> inbox.process(row.getId()))));
    return ResponseEntity.ok(mapper.createObjectNode());
  }
}
