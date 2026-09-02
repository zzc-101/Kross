package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.dto.AgentProtocol;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentSession;
import com.kross.api.ApiException;
import com.kross.catalog.CredentialVault;
import com.kross.catalog.SkillCatalogService;
import com.kross.channel.AgentSocketHub;
import com.kross.channel.ChannelEvent;
import com.kross.channel.WorkerOfferBus;
import com.kross.config.AppProperties;
import com.kross.connector.ConversationOutlet;
import com.kross.connector.ConversationTurnEvent;
import com.kross.knowledge.KnowledgeMcpService;
import com.kross.support.Tokens;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class AgentWorkerProtocolServiceTest {
  private AgentMapper mapper;
  private AgentRuntimeOps runtime;
  private AgentChannelPublisher channels;
  private KnowledgeMcpService knowledgeMcp;
  private AgentMemoryService memories;
  private ObjectMapper objectMapper;
  private AgentWorkerProtocolService service;
  private AgentSession session;

  @BeforeEach
  void setUp() {
    mapper = mock(AgentMapper.class);
    runtime = mock(AgentRuntimeOps.class);
    channels = mock(AgentChannelPublisher.class);
    knowledgeMcp = mock(KnowledgeMcpService.class);
    memories = mock(AgentMemoryService.class);
    objectMapper = new ObjectMapper().findAndRegisterModules();
    session = session("token-1", "org-1", "agent-1");
    when(runtime.authenticate("token-1")).thenReturn(session);
    when(knowledgeMcp.managedServer()).thenReturn(Optional.empty());
    when(memories.renderFiles("org-1", "user-1"))
        .thenReturn(new AgentMemoryService.MemoryFiles("", ""));
    service = new AgentWorkerProtocolService(
        mapper,
        mock(CredentialVault.class),
        new AppProperties(),
        mock(AgentSocketHub.class),
        mock(WorkerOfferBus.class),
        objectMapper,
        memories,
        mock(SkillCatalogService.class),
        mock(ModelCatalog.class),
        knowledgeMcp,
        runtime,
        new AgentTransactions(),
        channels,
        List.of());
  }

  @Test
  void concurrentClaimJobOnlyOneWorkerWinsWhenMapperReturnsOneRow() throws Exception {
    AgentMessage queued = userMessage("msg-1", "conv-1");
    AtomicInteger remaining = new AtomicInteger(1);
    when(mapper.claimJob(eq("agent-1"), anyString(), any(Instant.class))).thenAnswer(invocation -> {
      if (remaining.getAndSet(0) == 1) {
        queued.setLeaseId(invocation.getArgument(1));
        return Optional.of(queued);
      }
      return Optional.empty();
    });
    when(mapper.listHistory(any(), any(), any(), anyInt())).thenReturn(List.of());
    when(mapper.findReplyTo(any(), any())).thenReturn(Optional.empty());
    when(runtime.insertPlaceholder(any(), any())).thenAnswer(invocation ->
        replyTo(invocation.getArgument(1)));
    when(mapper.findConversation(any(), any())).thenReturn(Optional.empty());
    CountDownLatch start = new CountDownLatch(1);
    CountDownLatch done = new CountDownLatch(2);
    ConcurrentHashMap<String, AgentProtocol.Job> won = new ConcurrentHashMap<>();

    Thread first = Thread.ofVirtual().start(() -> claimOnce(start, done, won, "a"));
    Thread second = Thread.ofVirtual().start(() -> claimOnce(start, done, won, "b"));
    start.countDown();
    assertThat(done.await(2, TimeUnit.SECONDS)).isTrue();
    first.join();
    second.join();

    assertThat(won.values()).hasSize(1);
    verify(mapper, times(2)).claimJob(eq("agent-1"), anyString(), any(Instant.class));
  }

  @Test
  void ingestEventsPublishesDuplicatesAndOutOfOrderWithoutChangingLease() {
    AgentMessage user = userMessage("msg-1", "conv-1");
    AgentMessage reply = replyTo(user);
    when(mapper.findMessage("org-1", "msg-1")).thenReturn(Optional.of(user));
    when(mapper.findMessage("org-1", reply.getId())).thenReturn(Optional.of(reply));

    AgentProtocol.StreamEvent late = new AgentProtocol.StreamEvent(
        "text-delta", " world", null, null, null, null, null);
    AgentProtocol.StreamEvent early = new AgentProtocol.StreamEvent(
        "text-delta", "hello", null, null, null, null, null);
    AgentProtocol.StreamEventsRequest first = new AgentProtocol.StreamEventsRequest(
        "agent.events", "msg-1", reply.getId(), "lease-1", List.of(late, early));
    AgentProtocol.StreamEventsRequest replay = new AgentProtocol.StreamEventsRequest(
        "agent.events", "msg-1", reply.getId(), "lease-1", List.of(early));

    service.ingestEvents("token-1", first);
    service.ingestEvents("token-1", replay);

    verify(runtime, times(2)).requireActiveLease("agent-1", "msg-1", "lease-1");
    verify(channels, times(3)).emit(any(ChannelEvent.class));
    verify(mapper, never()).updateMessageBody(any());
    verify(mapper, times(2)).touch("agent-1");
  }

  @Test
  void postReplyNotifiesOutletOnDoneAndSkipsProcessingWithoutApproval() {
    ConversationOutlet outlet = mock(ConversationOutlet.class);
    service = new AgentWorkerProtocolService(
        mapper,
        mock(CredentialVault.class),
        new AppProperties(),
        mock(AgentSocketHub.class),
        mock(WorkerOfferBus.class),
        objectMapper,
        memories,
        mock(SkillCatalogService.class),
        mock(ModelCatalog.class),
        knowledgeMcp,
        runtime,
        new AgentTransactions(),
        channels,
        List.of(outlet));
    Agent agent = new Agent();
    agent.setId("agent-1");
    agent.setUserId("user-1");
    when(runtime.requireAgent("agent-1")).thenReturn(agent);
    AgentMessage user = userMessage("msg-1", "conv-1");
    AgentMessage reply = replyTo(user);
    when(mapper.recordDelivery("delivery-1", "agent-1", "msg-1")).thenReturn(1);
    when(mapper.findMessage("org-1", "msg-1")).thenReturn(Optional.of(user));
    when(mapper.findMessage("org-1", reply.getId())).thenReturn(Optional.of(reply));
    when(mapper.completeLeasedMessage("msg-1", "lease-1", "done", null)).thenReturn(1);

    service.postReply("token-1", new AgentProtocol.ReplyRequest(
        "agent.message",
        "msg-1",
        reply.getId(),
        "final answer",
        "done",
        "delivery-1",
        "lease-1",
        null,
        objectMapper.createArrayNode().addObject().put("type", "text").put("text", "final answer"),
        null,
        null));

    verify(outlet).onTurn(org.mockito.ArgumentMatchers.argThat(event ->
        event.kind() == ConversationTurnEvent.Kind.COMPLETED
            && "conv-1".equals(event.conversationId())
            && "user-1".equals(event.userId())));

    org.mockito.Mockito.reset(outlet);
    when(mapper.recordDelivery("delivery-2", "agent-1", "msg-1")).thenReturn(1);
    when(mapper.completeLeasedMessage("msg-1", "lease-1", "processing", null)).thenReturn(1);
    service.postReply("token-1", new AgentProtocol.ReplyRequest(
        "agent.message",
        "msg-1",
        reply.getId(),
        "partial",
        "processing",
        "delivery-2",
        "lease-1",
        null,
        objectMapper.createArrayNode().addObject().put("type", "text").put("text", "partial"),
        null,
        null));

    verify(outlet, never()).onTurn(any());
  }
    AgentMessage user = userMessage("msg-1", "conv-1");
    AgentMessage reply = replyTo(user);
    when(mapper.recordDelivery("delivery-1", "agent-1", "msg-1")).thenReturn(1, 0);
    when(mapper.findMessage("org-1", "msg-1")).thenReturn(Optional.of(user));
    when(mapper.findMessage("org-1", reply.getId())).thenReturn(Optional.of(reply));
    when(mapper.completeLeasedMessage("msg-1", "lease-1", "done", null)).thenReturn(1);
    AgentProtocol.ReplyRequest request = new AgentProtocol.ReplyRequest(
        "agent.message",
        "msg-1",
        reply.getId(),
        "final answer",
        "done",
        "delivery-1",
        "lease-1",
        null,
        objectMapper.createArrayNode().addObject().put("type", "text").put("text", "final answer"),
        null,
        null);

    service.postReply("token-1", request);
    service.postReply("token-1", request);

    verify(mapper).updateMessageBody(reply);
    assertThat(reply.getContent()).isEqualTo("final answer");
    assertThat(reply.getStatus()).isEqualTo("done");
    verify(mapper).completeLeasedMessage("msg-1", "lease-1", "done", null);
    verify(runtime).requireActiveLease("agent-1", "msg-1", "lease-1");
    verify(mapper, times(2)).recordDelivery("delivery-1", "agent-1", "msg-1");
  }

  @Test
  void workerSettingsMergesManagedKnowledgeMcp() {
    Agent agent = new Agent();
    agent.setId("agent-1");
    agent.setOrganizationId("org-1");
    agent.setUserId("user-1");
    when(runtime.requireAgent("agent-1")).thenReturn(agent);
    when(runtime.loadMcpServers("agent-1")).thenReturn(objectMapper.createObjectNode());
    when(knowledgeMcp.managedServer()).thenReturn(Optional.of(Map.of(
        "transport", "streamable-http",
        "url", "http://127.0.0.1:8787/mcp/knowledge",
        "risk", "read")));
    when(memories.renderFiles("org-1", "user-1"))
        .thenReturn(new AgentMemoryService.MemoryFiles("# user", "# memory"));

    AgentProtocol.WorkerSettings settings = service.workerSettings("token-1");

    assertThat(settings.mcpServers()).containsKey(KnowledgeMcpService.SERVER_ID);
    assertThat(settings.mcpServers().get(KnowledgeMcpService.SERVER_ID))
        .isInstanceOf(Map.class);
    @SuppressWarnings("unchecked")
    Map<String, Object> server = (Map<String, Object>) settings.mcpServers().get(KnowledgeMcpService.SERVER_ID);
    assertThat(server).containsEntry("risk", "read");
    assertThat(server).containsEntry("transport", "streamable-http");
    assertThat(settings.userMarkdown()).isEqualTo("# user");
  }

  @Test
  void ingestEventsRejectsLostLease() {
    org.mockito.Mockito.doThrow(ApiException.conflict("job_lease_lost", "Agent job lease is no longer active"))
        .when(runtime).requireActiveLease("agent-1", "msg-1", "lease-1");

    assertThatThrownBy(() -> service.ingestEvents("token-1", new AgentProtocol.StreamEventsRequest(
        "agent.events", "msg-1", "reply-1", "lease-1", List.of())))
        .isInstanceOf(ApiException.class)
        .extracting(error -> ((ApiException) error).getCode())
        .isEqualTo("job_lease_lost");
    verify(channels, never()).emit(any());
  }

  private void claimOnce(
      CountDownLatch start,
      CountDownLatch done,
      ConcurrentHashMap<String, AgentProtocol.Job> won,
      String label) {
    try {
      start.await(2, TimeUnit.SECONDS);
      service.claimJob("token-1").ifPresent(job -> won.put(label, job));
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    } finally {
      done.countDown();
    }
  }

  private static AgentSession session(String token, String organizationId, String agentId) {
    AgentSession row = new AgentSession();
    row.setTokenHash(Tokens.sha256Hex(token));
    row.setOrganizationId(organizationId);
    row.setAgentId(agentId);
    return row;
  }

  private static AgentMessage userMessage(String id, String conversationId) {
    AgentMessage row = new AgentMessage();
    row.setId(id);
    row.setOrganizationId("org-1");
    row.setAgentId("agent-1");
    row.setConversationId(conversationId);
    row.setRole("user");
    row.setContent("hello");
    row.setStatus("processing");
    row.setLeaseId("lease-1");
    row.setCreatedAt(Instant.parse("2026-09-01T00:00:00Z"));
    return row;
  }

  private static AgentMessage replyTo(AgentMessage user) {
    AgentMessage reply = new AgentMessage();
    reply.setId("reply-1");
    reply.setOrganizationId(user.getOrganizationId());
    reply.setAgentId(user.getAgentId());
    reply.setConversationId(user.getConversationId());
    reply.setReplyTo(user.getId());
    reply.setRole("agent");
    reply.setStatus("processing");
    reply.setCreatedAt(Instant.parse("2026-09-01T00:00:01Z"));
    return reply;
  }
}
