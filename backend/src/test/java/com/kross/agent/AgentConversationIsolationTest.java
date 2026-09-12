package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import com.kross.catalog.SkillCatalogService;
import com.kross.channel.AgentSocketHub;
import com.kross.channel.ChannelEventBus;
import com.kross.channel.WorkerOfferBus;
import com.kross.config.AppProperties;
import com.kross.identity.Identity;
import com.kross.identity.IdentityDirectory;
import com.kross.identity.IdentityMapper;
import com.kross.identity.OrganizationAccess;
import com.kross.storage.ObjectStorage;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

class AgentConversationIsolationTest {
  private IdentityDirectory directory;
  private AgentRuntimeOps runtime;
  private AgentMemoryService memories;
  private AgentConversationService service;
  private ScheduleService schedules;

  @BeforeEach
  void setUp() {
    directory = mock(IdentityDirectory.class);
    runtime = mock(AgentRuntimeOps.class);
    memories = mock(AgentMemoryService.class);
    when(directory.activeOrganizationStatus("org-a")).thenReturn("active");
    when(directory.activeOrganizationStatus("org-b")).thenReturn("active");
    when(directory.activeMembership("org-a", "user-1"))
        .thenReturn(new IdentityDirectory.MembershipGrant("mem-1", "member"));
    when(directory.activeMembership("org-b", "user-1")).thenReturn(null);
    SecurityContextHolder.getContext().setAuthentication(
        new UsernamePasswordAuthenticationToken(
            new Identity("user-1", "alice", "Alice", "user"), null));
    service = new AgentConversationService(
        mock(AgentMapper.class),
        new OrganizationAccess(directory),
        new ChannelEventBus(),
        mock(AgentSocketHub.class),
        mock(WorkerOfferBus.class),
        new ObjectMapper(),
        memories,
        mock(SkillCatalogService.class),
        mock(ModelCatalog.class),
        runtime,
        new AgentTransactions(),
        mock(AgentChannelPublisher.class),
        mock(ObjectStorage.class),
        new AppProperties(),
        new WorkspaceFileUrlCache());
    schedules = new ScheduleService(
        new OrganizationAccess(directory),
        runtime,
        mock(AgentScheduleMapper.class),
        mock(IdentityMapper.class),
        directory,
        mock(SkillCatalogService.class),
        service);
  }

  @AfterEach
  void clearSecurityContext() {
    SecurityContextHolder.clearContext();
  }

  @Test
  void rejectsCrossOrganizationConversationAccess() {
    ApiException error = assertDenied(() -> service.listConversations("org-b"));
    assertThat(error.getCode()).isEqualTo("organization_access_denied");
    verify(runtime, never()).ensure(any());
  }

  @Test
  void rejectsCrossOrganizationMemoryAccess() {
    ApiException error = assertDenied(() -> service.listMemories("org-b"));
    assertThat(error.getCode()).isEqualTo("organization_access_denied");
    verify(memories, never()).list(any());
  }

  @Test
  void rejectsCrossOrganizationWorkspaceAccess() {
    ApiException error = assertDenied(() -> service.listWorkspace("org-b", "."));
    assertThat(error.getCode()).isEqualTo("organization_access_denied");
    verify(runtime, never()).ensure(any());
    verify(runtime, never()).runWorkspaceCommand(any(), any(), any(), any());
  }

  @Test
  void rejectsCrossOrganizationWorkspaceMutation() {
    ApiException upload = assertDenied(
        () -> service.prepareWorkspaceUpload("org-b", new com.kross.agent.dto.WorkspaceUploadRequest(".", "a.txt", "text/plain", 1)));
    assertThat(upload.getCode()).isEqualTo("organization_access_denied");
    ApiException commit = assertDenied(
        () -> service.commitWorkspaceUpload("org-b", new com.kross.agent.dto.WorkspaceUploadCommitRequest("k", ".", "a.txt", "text/plain", 1)));
    assertThat(commit.getCode()).isEqualTo("organization_access_denied");
    ApiException delete = assertDenied(() -> service.deleteWorkspacePath("org-b", "a.txt"));
    assertThat(delete.getCode()).isEqualTo("organization_access_denied");
    ApiException mkdir = assertDenied(
        () -> service.createWorkspaceDirectory("org-b", new com.kross.agent.dto.WorkspaceDirectoryRequest("docs")));
    assertThat(mkdir.getCode()).isEqualTo("organization_access_denied");
    ApiException content = assertDenied(
        () -> service.redirectWorkspaceFile("org-b", "a.txt", true, mock(jakarta.servlet.http.HttpServletResponse.class)));
    assertThat(content.getCode()).isEqualTo("organization_access_denied");
    verify(runtime, never()).ensure(any());
  }

  @Test
  void rejectsCrossOrganizationScheduleAccess() {
    ApiException list = assertDenied(() -> schedules.list("org-b"));
    assertThat(list.getCode()).isEqualTo("organization_access_denied");
    ApiException create = assertDenied(
        () -> schedules.create("org-b", new com.kross.agent.dto.ScheduleRequest(
            "daily", "hello", null, "new_conversation", null, "UTC", "cron", "0 9 * * *", null, null)));
    assertThat(create.getCode()).isEqualTo("organization_access_denied");
    ApiException patch = assertDenied(
        () -> schedules.patch("org-b", "sched-1", new com.kross.agent.dto.ScheduleRequest(
            "x", null, null, null, null, null, null, null, null, "paused")));
    assertThat(patch.getCode()).isEqualTo("organization_access_denied");
    ApiException delete = assertDenied(() -> schedules.delete("org-b", "sched-1"));
    assertThat(delete.getCode()).isEqualTo("organization_access_denied");
    ApiException run = assertDenied(() -> schedules.runNow("org-b", "sched-1"));
    assertThat(run.getCode()).isEqualTo("organization_access_denied");
    verify(runtime, never()).ensure(any());
  }

  @Test
  void rejectsCrossOrganizationMessageAccess() {
    ApiException error = assertDenied(
        () -> service.listMessages("org-b", "conversation-from-org-a", Optional.empty()));
    assertThat(error.getCode()).isEqualTo("organization_access_denied");
    verify(runtime, never()).requireConversation(any(), any(), any());
  }

  private static ApiException assertDenied(Runnable action) {
    return catchThrowableOfType(ApiException.class, action::run);
  }
}
