package com.kross.controller;

import com.kross.agent.AgentService;
import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.AgentModelView;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.CloneWorkspaceRequest;
import com.kross.agent.dto.CloneWorkspaceView;
import com.kross.agent.dto.ConversationView;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.GitStatusView;
import com.kross.agent.dto.PatchConversationRequest;
import com.kross.agent.dto.ResolveToolApprovalRequest;
import com.kross.agent.dto.WorkspaceListingView;
import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
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
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequiredArgsConstructor
@RequestMapping("/agent")
public class AgentController {
  private final AgentService agents;

  @GetMapping("/model")
  public Res<AgentModelView> model(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(agents.currentModel(organizationId));
  }

  @GetMapping("/models")
  public Res<ItemList<AgentModelView>> models(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(new ItemList<>(agents.listModels(organizationId)));
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

  @PostMapping("/conversations/{conversationId}/approvals/{approvalId}")
  public Res<Void> resolveApproval(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String conversationId,
      @PathVariable String approvalId,
      @RequestBody ResolveToolApprovalRequest request) {
    agents.resolveApproval(organizationId, conversationId, approvalId, request);
    return Res.ok();
  }

  @GetMapping("/workspace/files")
  public Res<WorkspaceListingView> workspaceFiles(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam Optional<String> path) {
    return Res.ok(agents.listWorkspace(organizationId, path.orElse(".")));
  }

  @GetMapping("/workspace/git")
  public Res<GitStatusView> workspaceGit(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam Optional<String> path) {
    return Res.ok(agents.gitStatus(organizationId, path.orElse(".")));
  }

  @PostMapping("/workspace/git/clone")
  public Res<CloneWorkspaceView> cloneWorkspace(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody CloneWorkspaceRequest request) {
    return Res.ok(agents.cloneWorkspace(organizationId, request));
  }

  @GetMapping(path = "/conversations/{conversationId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public SseEmitter events(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String conversationId,
      HttpServletResponse response) {
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("X-Accel-Buffering", "no");
    response.setHeader("Connection", "keep-alive");
    return agents.subscribe(organizationId, conversationId);
  }

}
