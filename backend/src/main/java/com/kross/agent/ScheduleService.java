package com.kross.agent;

import com.kross.agent.dto.AppendAgentMessageRequest;
import com.kross.agent.dto.CreateConversationRequest;
import com.kross.agent.dto.ScheduleRequest;
import com.kross.agent.dto.ScheduleRunView;
import com.kross.agent.dto.ScheduleView;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentConversation;
import com.kross.agent.entity.AgentSchedule;
import com.kross.agent.entity.AgentScheduleRun;
import com.kross.api.ApiException;
import com.kross.catalog.SkillCatalogService;
import com.kross.identity.Identity;
import com.kross.identity.IdentityContexts;
import com.kross.identity.IdentityDirectory;
import com.kross.identity.IdentityMapper;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.identity.OrganizationContext;
import com.kross.identity.entity.Organization;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
@RequiredArgsConstructor
public class ScheduleService {
  private static final int MAX_OPEN = 10;
  private static final int MAX_FAILURES = 3;
  private static final int CLAIM_BATCH = 20;
  private static final int RUN_LIMIT = 50;
  private static final int MAX_NAME_CHARS = 80;
  private static final int MAX_PROMPT_CHARS = 32_768;
  private static final DateTimeFormatter TITLE_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

  private final OrganizationAccess access;
  private final AgentRuntimeOps runtime;
  private final AgentScheduleMapper schedules;
  private final IdentityMapper identities;
  private final IdentityDirectory directory;
  private final SkillCatalogService skills;
  private final AgentConversationService conversations;

  public List<ScheduleView> list(String organizationId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    runtime.ensure(context);
    return schedules.listOwned(context.organizationId(), context.userId()).stream()
        .map(ScheduleService::toView)
        .toList();
  }

  @Transactional
  public ScheduleView create(String organizationId, ScheduleRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    if (schedules.countOwnedOpen(context.organizationId(), context.userId()) >= MAX_OPEN) {
      throw ApiException.invalidRequest("Too many scheduled tasks");
    }
    Instant now = Instant.now();
    AgentSchedule row = new AgentSchedule();
    row.setId(UUID.randomUUID().toString());
    row.setOrganizationId(context.organizationId());
    row.setAgentId(agent.getId());
    row.setUserId(context.userId());
    applyDefinition(context, agent, row, Optional.ofNullable(request).orElseThrow(), now, true);
    row.setStatus("active");
    row.setConsecutiveFailures(0);
    row.setCreatedAt(now);
    row.setUpdatedAt(now);
    schedules.insert(row);
    return toView(row);
  }

  @Transactional
  public ScheduleView patch(String organizationId, String scheduleId, ScheduleRequest request) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    Agent agent = runtime.ensure(context);
    AgentSchedule row = requireOwned(context, scheduleId);
    Instant now = Instant.now();
    applyDefinition(context, agent, row, Optional.ofNullable(request).orElseThrow(), now, false);
    optionalText(request.status()).ifPresent(status -> applyStatus(row, status, now));
    row.setUpdatedAt(now);
    if (schedules.update(row) == 0) {
      throw ApiException.notFound("Scheduled task");
    }
    return toView(schedules.findOwned(context.organizationId(), context.userId(), row.getId()).orElse(row));
  }

  @Transactional
  public void delete(String organizationId, String scheduleId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    runtime.ensure(context);
    requireOwned(context, scheduleId);
    if (schedules.deleteOwned(context.organizationId(), context.userId(), scheduleId) == 0) {
      throw ApiException.notFound("Scheduled task");
    }
  }

  public List<ScheduleRunView> listRuns(String organizationId, String scheduleId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_READ);
    runtime.ensure(context);
    requireOwned(context, scheduleId);
    return schedules.listRuns(context.organizationId(), scheduleId, RUN_LIMIT).stream()
        .map(ScheduleService::toRunView)
        .toList();
  }

  public ScheduleView runNow(String organizationId, String scheduleId) {
    OrganizationContext context = access.require(organizationId, OrganizationAction.AGENT_CHAT);
    runtime.ensure(context);
    ClaimedBeat beat = Optional.ofNullable(runtime.tx().execute(status -> startManualRun(context, scheduleId)))
        .orElseThrow(() -> ApiException.notFound("Scheduled task"));
    fulfill(beat.schedule(), beat.run());
    return toView(schedules.findOwned(context.organizationId(), context.userId(), beat.schedule().getId())
        .orElse(beat.schedule()));
  }

  @Transactional
  public List<ClaimedBeat> claimDue() {
    Instant now = Instant.now();
    List<ClaimedBeat> beats = new ArrayList<>();
    for (AgentSchedule row : schedules.lockDue(CLAIM_BATCH)) {
      Instant due = Optional.ofNullable(row.getNextRunAt()).orElse(now);
      advanceAfterClaim(row, now);
      if (schedules.applyClaim(row) == 0) {
        continue;
      }
      AgentScheduleRun run = newRun(row, due, now, "started");
      schedules.insertRun(run);
      beats.add(new ClaimedBeat(row, run));
    }
    return beats;
  }

  public void fulfill(AgentSchedule row, AgentScheduleRun run) {
    if (overlap(row.getId(), run.getId())) {
      finish(run, "skipped", null, null, "Previous run is still in progress");
      return;
    }
    if (!actorReady(row)) {
      finish(run, "skipped", null, null, "Owner or organization is not active");
      return;
    }
    try {
      Identity identity = requireIdentity(row.getUserId());
      IdentityContexts.runAs(identity, () -> {
        String conversationId = conversationFor(row);
        var message = conversations.appendMessage(
            row.getOrganizationId(),
            conversationId,
            new AppendAgentMessageRequest(row.getPrompt()));
        finish(run, "started", conversationId, message.id(), null);
        schedules.resetFailures(row.getId(), row.getStatus(), Instant.now());
        return message;
      });
    } catch (RuntimeException error) {
      log.warn("Scheduled task {} failed to dispatch: {}", row.getId(), error.getMessage());
      finish(run, "failed", run.getConversationId(), run.getUserMessageId(), clipError(error.getMessage()));
      int failures = row.getConsecutiveFailures() + 1;
      String status = failures >= MAX_FAILURES ? "error" : row.getStatus();
      schedules.recordFailure(row.getId(), row.getStatus(), status, failures, Instant.now());
    }
  }

  private ClaimedBeat startManualRun(OrganizationContext context, String scheduleId) {
    AgentSchedule row = requireOwned(context, scheduleId);
    if ("done".equals(row.getStatus())) {
      throw ApiException.invalidRequest("Scheduled task has already finished");
    }
    Instant now = Instant.now();
    AgentScheduleRun run = newRun(row, Optional.ofNullable(row.getNextRunAt()).orElse(now), now, "started");
    schedules.insertRun(run);
    if ("once".equals(row.getKind())) {
      row.setStatus("done");
      row.setNextRunAt(null);
      row.setLastRunAt(now);
      row.setUpdatedAt(now);
      schedules.update(row);
    }
    return new ClaimedBeat(row, run);
  }

  private void applyDefinition(
      OrganizationContext context,
      Agent agent,
      AgentSchedule row,
      ScheduleRequest request,
      Instant now,
      boolean creating) {
    if (creating || request.name() != null) {
      row.setName(requireName(request.name(), true));
    }
    if (creating || request.prompt() != null) {
      row.setPrompt(requirePrompt(request.prompt(), true));
    }
    if (creating || request.skillId() != null) {
      row.setSkillId(optionalInstalledSkill(context.organizationId(), request.skillId()));
    }
    if (creating || request.conversationMode() != null) {
      row.setConversationMode(requireMode(request.conversationMode()));
    }
    if (creating || request.conversationId() != null || request.conversationMode() != null) {
      row.setConversationId(pinnedConversation(
          context,
          agent,
          row.getConversationMode(),
          request.conversationId() != null ? request.conversationId() : row.getConversationId()));
    }
    if (creating || optionalText(request.timezone()).isPresent()) {
      String timezone = optionalText(request.timezone()).orElseGet(() -> defaultTimezone(context.organizationId()));
      row.setTimezone(ScheduleExpressions.zone(timezone).getId());
    }
    String kind = optionalText(request.kind()).orElseGet(() -> Optional.ofNullable(row.getKind()).orElse(""));
    applyTrigger(row, kind, request.cronExpr(), request.runAt(), now, creating);
  }

  private void applyTrigger(
      AgentSchedule row, String kind, String cronExpr, String runAt, Instant now, boolean creating) {
    String normalized = Optional.ofNullable(kind).map(String::trim).orElse("");
    if (!List.of("once", "cron").contains(normalized)) {
      throw ApiException.invalidRequest("kind must be once or cron");
    }
    row.setKind(normalized);
    if ("cron".equals(normalized)) {
      row.setCronExpr(ScheduleExpressions.requireCron(
          optionalText(cronExpr).orElse(row.getCronExpr())));
      row.setRunAt(null);
      row.setNextRunAt(ScheduleExpressions.nextCron(row.getCronExpr(), row.getTimezone(), now));
      return;
    }
    Instant when = optionalText(runAt)
        .map(raw -> ScheduleExpressions.parseRunAt(raw, row.getTimezone()))
        .orElseGet(() -> Optional.ofNullable(row.getRunAt())
            .orElseThrow(() -> ApiException.invalidRequest("runAt is required")));
    boolean changed = Optional.ofNullable(row.getRunAt()).map(existing -> !existing.equals(when)).orElse(true);
    if ((creating || changed) && !when.isAfter(now)) {
      throw ApiException.invalidRequest("runAt must be in the future");
    }
    row.setCronExpr(null);
    row.setRunAt(when);
    if (creating || changed || row.getNextRunAt() == null) {
      row.setNextRunAt(when);
    }
  }

  private void applyStatus(AgentSchedule row, String status, Instant now) {
    if (!List.of("active", "paused").contains(status)) {
      throw ApiException.invalidRequest("status must be active or paused");
    }
    if ("done".equals(row.getStatus())) {
      throw ApiException.invalidRequest("Scheduled task has already finished");
    }
    if ("active".equals(status) && List.of("paused", "error").contains(row.getStatus())) {
      if ("cron".equals(row.getKind())) {
        row.setNextRunAt(ScheduleExpressions.nextCron(row.getCronExpr(), row.getTimezone(), now));
      } else if (Optional.ofNullable(row.getRunAt()).filter(when -> when.isAfter(now)).isEmpty()) {
        throw ApiException.invalidRequest("One-time task is already due");
      } else {
        row.setNextRunAt(row.getRunAt());
      }
      row.setConsecutiveFailures(0);
    }
    row.setStatus(status);
  }

  private void advanceAfterClaim(AgentSchedule row, Instant now) {
    row.setLastRunAt(now);
    row.setUpdatedAt(now);
    if ("once".equals(row.getKind())) {
      row.setStatus("done");
      row.setNextRunAt(null);
      return;
    }
    row.setNextRunAt(ScheduleExpressions.nextCron(row.getCronExpr(), row.getTimezone(), now));
  }

  private boolean overlap(String scheduleId, String currentRunId) {
    if (schedules.hasOpenDispatch(scheduleId, currentRunId)) {
      return true;
    }
    return schedules.latestRunMessageStatus(scheduleId)
        .filter(status -> "queued".equals(status) || "processing".equals(status))
        .isPresent();
  }

  private boolean actorReady(AgentSchedule row) {
    if (!"active".equals(directory.activeOrganizationStatus(row.getOrganizationId()))) {
      return false;
    }
    return Optional.ofNullable(directory.findUser(row.getUserId()))
        .filter(user -> "active".equals(user.status()))
        .isPresent();
  }

  private String conversationFor(AgentSchedule row) {
    if ("pinned_conversation".equals(row.getConversationMode())) {
      return Optional.ofNullable(row.getConversationId())
          .orElseThrow(() -> ApiException.invalidRequest("Pinned conversation is required"));
    }
    ZoneId zone = ScheduleExpressions.zone(row.getTimezone());
    String title = "[" + row.getName() + "] " + TITLE_TIME.format(Instant.now().atZone(zone));
    return conversations.createConversation(
        row.getOrganizationId(),
        new CreateConversationRequest(title, row.getSkillId(), null)).id();
  }

  private AgentSchedule requireOwned(OrganizationContext context, String scheduleId) {
    return schedules.findOwned(context.organizationId(), context.userId(), scheduleId)
        .orElseThrow(() -> ApiException.notFound("Scheduled task"));
  }

  private String optionalInstalledSkill(String organizationId, String skillId) {
    return optionalText(skillId)
        .map(id -> skills.findInstalledSkill(organizationId, id)
            .orElseThrow(() -> ApiException.notFound("Installed Skill"))
            .getId())
        .orElse(null);
  }

  private String pinnedConversation(
      OrganizationContext context, Agent agent, String mode, String conversationId) {
    if (!"pinned_conversation".equals(mode)) {
      return null;
    }
    String id = optionalText(conversationId)
        .orElseThrow(() -> ApiException.invalidRequest("Pinned conversation is required"));
    AgentConversation conversation = runtime.requireConversation(context, agent, id);
    if (Optional.ofNullable(conversation.getArchivedAt()).isPresent()) {
      throw ApiException.invalidRequest("Archived conversations cannot accept messages");
    }
    return conversation.getId();
  }

  private String defaultTimezone(String organizationId) {
    return identities.findOrganization(organizationId)
        .map(Organization::getDefaultTimezone)
        .flatMap(ScheduleService::optionalText)
        .orElse("UTC");
  }

  private Identity requireIdentity(String userId) {
    return Optional.ofNullable(directory.findUser(userId))
        .filter(user -> "active".equals(user.status()))
        .map(user -> new Identity(user.id(), user.username(), user.displayName(), user.platformRole()))
        .orElseThrow(() -> new ApiException("unauthenticated", "Sign in required", 401));
  }

  private void finish(
      AgentScheduleRun run, String status, String conversationId, String messageId, String error) {
    run.setStatus(status);
    run.setConversationId(conversationId);
    run.setUserMessageId(messageId);
    run.setError(error);
    schedules.finishRun(run);
  }

  private static AgentScheduleRun newRun(AgentSchedule row, Instant due, Instant claimedAt, String status) {
    AgentScheduleRun run = new AgentScheduleRun();
    run.setId(UUID.randomUUID().toString());
    run.setScheduleId(row.getId());
    run.setOrganizationId(row.getOrganizationId());
    run.setDueAt(due);
    run.setClaimedAt(claimedAt);
    run.setStatus(status);
    return run;
  }

  private static String requireName(String raw, boolean required) {
    String value = Optional.ofNullable(raw).map(String::trim).orElse("");
    if (value.isEmpty()) {
      if (!required) {
        return value;
      }
      throw ApiException.invalidRequest("Name is required");
    }
    if (value.length() > MAX_NAME_CHARS) {
      throw ApiException.invalidRequest("Name is too long");
    }
    return value;
  }

  private static String requirePrompt(String raw, boolean required) {
    String value = Optional.ofNullable(raw).map(String::trim).orElse("");
    if (value.isEmpty()) {
      if (!required) {
        return value;
      }
      throw ApiException.invalidRequest("Prompt is required");
    }
    if (value.length() > MAX_PROMPT_CHARS) {
      throw ApiException.invalidRequest("Prompt is too long");
    }
    return value;
  }

  private static String requireMode(String mode) {
    String value = Optional.ofNullable(mode).map(String::trim).orElse("new_conversation");
    if (!List.of("new_conversation", "pinned_conversation").contains(value)) {
      throw ApiException.invalidRequest("Invalid conversation mode");
    }
    return value;
  }

  private static String clipError(String error) {
    return Optional.ofNullable(error).map(String::trim).filter(value -> !value.isEmpty())
        .map(value -> value.length() > 500 ? value.substring(0, 500) : value)
        .orElse("dispatch failed");
  }

  private static Optional<String> optionalText(String value) {
    return Optional.ofNullable(value).map(String::trim).filter(item -> !item.isEmpty());
  }

  private static ScheduleView toView(AgentSchedule row) {
    return new ScheduleView(
        row.getId(),
        row.getName(),
        row.getPrompt(),
        row.getSkillId(),
        row.getConversationMode(),
        row.getConversationId(),
        row.getTimezone(),
        row.getKind(),
        row.getCronExpr(),
        row.getRunAt(),
        row.getNextRunAt(),
        row.getLastRunAt(),
        row.getStatus(),
        row.getConsecutiveFailures(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  private static ScheduleRunView toRunView(AgentScheduleRun row) {
    return new ScheduleRunView(
        row.getId(),
        row.getScheduleId(),
        row.getConversationId(),
        row.getUserMessageId(),
        row.getDueAt(),
        row.getClaimedAt(),
        row.getStatus(),
        row.getError());
  }

  public record ClaimedBeat(AgentSchedule schedule, AgentScheduleRun run) {}
}
