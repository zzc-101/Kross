package com.kross.controller;

import com.kross.agent.AgentConversationService;
import com.kross.agent.ScheduleService;
import com.kross.agent.dto.AgentMessageView;
import com.kross.agent.dto.AgentModelView;
import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.ConversationView;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.CreateMemoryRequest;
import com.kross.agent.dto.MemoryView;
import com.kross.agent.dto.PatchMemoryRequest;
import com.kross.agent.dto.RememberMemoryRequest;
import com.kross.agent.dto.ScheduleRequest;
import com.kross.agent.dto.ScheduleRunView;
import com.kross.agent.dto.ScheduleView;
import com.kross.agent.dto.PatchConversationRequest;
import com.kross.agent.dto.ResolveToolApprovalRequest;
import com.kross.agent.dto.SkillView;
import com.kross.agent.dto.WorkspaceDirectoryRequest;
import com.kross.agent.dto.WorkspaceFileView;
import com.kross.agent.dto.WorkspaceListingView;
import com.kross.agent.dto.WorkspaceStoredFileView;
import com.kross.agent.dto.WorkspaceUploadCommitRequest;
import com.kross.agent.dto.WorkspaceUploadRequest;
import com.kross.agent.dto.WorkspaceUploadView;
import com.kross.api.ApiException;
import com.kross.api.ApiHeaders;
import com.kross.api.ItemList;
import com.kross.api.Res;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
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
  private final AgentConversationService agents;
  private final ScheduleService schedules;

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
        organizationId, Optional.ofNullable(request).orElse(new CreateConversationRequest(null, null, null))));
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

  @GetMapping("/workspace/file")
  public Res<WorkspaceFileView> workspaceFile(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam String path) {
    return Res.ok(agents.readWorkspaceFile(organizationId, path));
  }

  @PostMapping("/workspace/file/upload")
  public Res<WorkspaceUploadView> prepareWorkspaceUpload(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody WorkspaceUploadRequest request) {
    return Res.ok(agents.prepareWorkspaceUpload(organizationId, request));
  }

  @PostMapping("/workspace/file/commit")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<WorkspaceStoredFileView> commitWorkspaceUpload(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody WorkspaceUploadCommitRequest request) {
    return Res.ok(agents.commitWorkspaceUpload(organizationId, request));
  }

  @GetMapping("/workspace/file/content")
  public void workspaceFileContent(
      @RequestHeader(value = ApiHeaders.ORGANIZATION_ID, required = false) Optional<String> organizationHeader,
      @RequestParam Optional<String> organizationId,
      @RequestParam String path,
      @RequestParam Optional<Boolean> inline,
      HttpServletResponse response) {
    agents.redirectWorkspaceFile(
        requireOrganizationId(organizationHeader, organizationId),
        path,
        inline.orElse(true),
        response);
  }

  @DeleteMapping("/workspace/file")
  public Res<WorkspaceStoredFileView> deleteWorkspaceFile(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestParam String path) {
    return Res.ok(agents.deleteWorkspacePath(organizationId, path));
  }

  @PostMapping("/workspace/directory")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<WorkspaceStoredFileView> createWorkspaceDirectory(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody WorkspaceDirectoryRequest request) {
    return Res.ok(agents.createWorkspaceDirectory(organizationId, request));
  }

  @GetMapping("/schedules")
  public Res<ItemList<ScheduleView>> schedules(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(new ItemList<>(schedules.list(organizationId)));
  }

  @PostMapping("/schedules")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<ScheduleView> createSchedule(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody ScheduleRequest request) {
    return Res.ok(schedules.create(organizationId, request));
  }

  @PatchMapping("/schedules/{scheduleId}")
  public Res<ScheduleView> patchSchedule(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String scheduleId,
      @RequestBody ScheduleRequest request) {
    return Res.ok(schedules.patch(organizationId, scheduleId, request));
  }

  @DeleteMapping("/schedules/{scheduleId}")
  public Res<Void> deleteSchedule(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String scheduleId) {
    schedules.delete(organizationId, scheduleId);
    return Res.ok();
  }

  @PostMapping("/schedules/{scheduleId}/run")
  public Res<ScheduleView> runSchedule(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String scheduleId) {
    return Res.ok(schedules.runNow(organizationId, scheduleId));
  }

  @GetMapping("/schedules/{scheduleId}/runs")
  public Res<ItemList<ScheduleRunView>> scheduleRuns(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String scheduleId) {
    return Res.ok(new ItemList<>(schedules.listRuns(organizationId, scheduleId)));
  }

  @GetMapping("/skills")
  public Res<ItemList<SkillView>> skills(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(new ItemList<>(agents.listSkills(organizationId)));
  }

  @GetMapping("/memories")
  public Res<ItemList<MemoryView>> memories(@RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId) {
    return Res.ok(new ItemList<>(agents.listMemories(organizationId)));
  }

  @PostMapping("/memories")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<MemoryView> createMemory(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody CreateMemoryRequest request) {
    return Res.ok(agents.createMemory(organizationId, request));
  }

  @PostMapping("/memories/remember")
  @ResponseStatus(HttpStatus.CREATED)
  public Res<MemoryView> rememberMemory(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @RequestBody RememberMemoryRequest request) {
    return Res.ok(agents.rememberMemory(organizationId, request));
  }

  @PatchMapping("/memories/{memoryId}")
  public Res<MemoryView> patchMemory(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String memoryId,
      @RequestBody PatchMemoryRequest request) {
    return Res.ok(agents.patchMemory(organizationId, memoryId, request));
  }

  @DeleteMapping("/memories/{memoryId}")
  public Res<Void> forgetMemory(
      @RequestHeader(ApiHeaders.ORGANIZATION_ID) String organizationId,
      @PathVariable String memoryId) {
    agents.forgetMemory(organizationId, memoryId);
    return Res.ok();
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

  private static String requireOrganizationId(Optional<String> header, Optional<String> query) {
    return header.map(String::trim).filter(value -> !value.isBlank())
        .or(() -> query.map(String::trim).filter(value -> !value.isBlank()))
        .orElseThrow(() -> ApiException.invalidRequest("organization is required"));
  }

}
