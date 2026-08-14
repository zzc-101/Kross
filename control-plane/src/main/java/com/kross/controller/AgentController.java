package com.kross.controller;

import com.kross.agent.AgentService;
import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.AgentView;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.ConversationView;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.PatchConversationRequest;
import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/agent")
public class AgentController {
  private final AgentService agents;

  @GetMapping
  public Res<AgentView> get(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(agents.getMine(organizationId));
  }

  @GetMapping("/conversations")
  public Res<ItemList<ConversationView>> conversations(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(new ItemList<>(agents.listConversations(organizationId)));
  }

  @PostMapping("/conversations")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<ConversationView> createConversation(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody(required = false) CreateConversationRequest request) {
    return Res.ok(agents.createConversation(
        organizationId, Optional.ofNullable(request).orElse(new CreateConversationRequest(null))));
  }

  @PatchMapping("/conversations/{conversationId}")
  public Res<ConversationView> patchConversation(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String conversationId,
      @RequestBody PatchConversationRequest request) {
    return Res.ok(agents.patchConversation(organizationId, conversationId, request));
  }

  @PostMapping("/conversations/{conversationId}/messages")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<AgentMessageView> append(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String conversationId,
      @RequestBody AppendAgentMessageRequest request) {
    return Res.ok(agents.appendMessage(organizationId, conversationId, request));
  }

  @GetMapping("/conversations/{conversationId}/messages")
  public Res<ItemList<AgentMessageView>> messages(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String conversationId,
      @RequestParam Optional<Integer> limit) {
    return Res.ok(new ItemList<>(agents.listMessages(organizationId, conversationId, limit)));
  }

  @PostMapping("/sleep")
  public Res<AgentView> sleep(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(agents.sleepMine(organizationId));
  }
}
