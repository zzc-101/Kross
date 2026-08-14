package com.kross.agent;

import com.kross.agent.dto.AgentProtocol;
import com.kross.api.ApiException;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/internal/v2/agents")
public class InternalAgentController {
  private final AgentService agents;

  @PostMapping("/register")
  public AgentProtocol.Registered register(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody AgentProtocol.RegisterRequest message) {
    requireType(message.type(), "agent.register");
    return agents.register(bearer(authorization), message);
  }

  @PostMapping("/heartbeat")
  public AgentProtocol.HeartbeatAck heartbeat(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody AgentProtocol.HeartbeatRequest message) {
    requireType(message.type(), "agent.heartbeat");
    return agents.heartbeat(bearer(authorization), message);
  }

  @GetMapping("/jobs")
  public ResponseEntity<AgentProtocol.Job> jobs(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
    return agents.claimJob(bearer(authorization))
        .map(ResponseEntity::ok)
        .orElseGet(() -> ResponseEntity.noContent().build());
  }

  @PostMapping("/messages")
  public ResponseEntity<Void> messages(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody AgentProtocol.ReplyRequest message) {
    requireType(message.type(), "agent.message");
    agents.postReply(bearer(authorization), message);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/sleep")
  public ResponseEntity<Void> sleep(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody AgentProtocol.SleepRequest message) {
    requireType(message.type(), "agent.sleep");
    agents.sleepFromWorker(bearer(authorization), message);
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/model-environment")
  public AgentProtocol.ModelEnvironment modelEnvironment(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
    return agents.modelEnvironment(bearer(authorization));
  }

  private static String bearer(String authorization) {
    String header = Optional.ofNullable(authorization).orElse("");
    if (!header.startsWith("Bearer ") || header.length() <= 7) {
      throw new ApiException("agent_unauthenticated", "Agent Bearer token is required", 401);
    }
    return header.substring("Bearer ".length());
  }

  private static void requireType(String actual, String expected) {
    if (!expected.equals(actual)) {
      throw new ApiException(
          "agent_message_route_mismatch", "Agent message type does not match route", 400);
    }
  }
}
