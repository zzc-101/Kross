package com.kross.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.dto.CreateMemoryRequest;
import com.kross.agent.dto.MemoryView;
import com.kross.agent.dto.PatchMemoryRequest;
import com.kross.agent.dto.RememberMemoryRequest;
import com.kross.agent.entity.Agent;
import com.kross.agent.entity.AgentMemory;
import com.kross.agent.entity.AgentMessage;
import com.kross.agent.entity.AgentSettings;
import com.kross.api.ApiException;
import com.kross.channel.AgentSocketHub;
import com.kross.identity.OrganizationContext;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Slf4j
@Service
@RequiredArgsConstructor
public class AgentMemoryService {
  static final int USER_MARKDOWN_BUDGET = 1_375;
  static final int MEMORY_MARKDOWN_BUDGET = 2_200;
  private static final int MAX_CONTENT_CHARS = 2_000;
  private static final int EXTRACT_MESSAGE_LIMIT = 40;
  private static final int EXTRACT_MESSAGE_CLIP = 1_200;
  private static final int FORGOTTEN_HINT_LIMIT = 80;
  private static final Pattern REMEMBER_HELP = Pattern.compile(
      "(?is)^(?:请)?帮我记住(?:这个|一下)?[：:,，\\s]+(.+)$");
  private static final Pattern REMEMBER_PLEASE = Pattern.compile(
      "(?is)^请记住[：:,，\\s]+(.+)$");
  private static final Pattern REMEMBER_ENGLISH = Pattern.compile(
      "(?is)^(?:please\\s+)?remember(?:\\s+this|\\s+that)[：:,\\s]+(.+)$");
  private static final Pattern PREFERENCE_HINT = Pattern.compile(
      "(?i)喜欢|偏好|请用|请叫|称呼|语言|风格|习惯|prefer|please (?:use|call|speak)|language");

  private final AgentMapper agents;
  private final AgentMemoryMapper memories;
  private final AgentSocketHub sockets;
  private final ObjectMapper mapper;
  private final ConcurrentHashMap<String, Object> extractLocks = new ConcurrentHashMap<>();

  public List<MemoryView> list(OrganizationContext context) {
    return memories.listActive(context.organizationId(), context.userId()).stream()
        .map(AgentMemoryService::toView)
        .toList();
  }

  public MemoryView create(OrganizationContext context, Agent agent, CreateMemoryRequest request) {
    AgentMemory row = insert(
        context.organizationId(),
        context.userId(),
        agent.getId(),
        requireKind(Optional.ofNullable(request).map(CreateMemoryRequest::kind)),
        requireContent(Optional.ofNullable(request).map(CreateMemoryRequest::content)),
        "manual");
    syncFilesQuietly(agent);
    return toView(row);
  }

  public MemoryView patch(
      OrganizationContext context, Agent agent, String memoryId, PatchMemoryRequest request) {
    AgentMemory row = memories.findOwned(context.organizationId(), context.userId(), memoryId)
        .filter(item -> item.getForgottenAt() == null)
        .orElseThrow(() -> ApiException.notFound("Memory"));
    Optional.ofNullable(request).map(PatchMemoryRequest::kind)
        .ifPresent(kind -> row.setKind(requireKind(Optional.of(kind))));
    Optional.ofNullable(request).map(PatchMemoryRequest::content)
        .ifPresent(content -> row.setContent(requireContent(Optional.of(content))));
    row.setUpdatedAt(Instant.now());
    if (memories.updateContent(row) == 0) {
      throw ApiException.notFound("Memory");
    }
    syncFilesQuietly(agent);
    return toView(memories.findOwned(context.organizationId(), context.userId(), row.getId()).orElse(row));
  }

  public void forget(OrganizationContext context, Agent agent, String memoryId) {
    memories.findOwned(context.organizationId(), context.userId(), memoryId)
        .orElseThrow(() -> ApiException.notFound("Memory"));
    if (memories.forget(memoryId, context.organizationId(), context.userId(), Instant.now()) == 0) {
      throw ApiException.notFound("Memory");
    }
    syncFilesQuietly(agent);
  }

  public MemoryView remember(OrganizationContext context, Agent agent, RememberMemoryRequest request) {
    String content = resolveRememberContent(context, agent, Optional.ofNullable(request));
    String stored = rememberPayload(content).orElse(content);
    String kind = Optional.ofNullable(request).map(RememberMemoryRequest::kind)
        .flatMap(AgentMemoryService::optionalText)
        .map(value -> requireKind(Optional.of(value)))
        .orElseGet(() -> inferKind(stored));
    AgentMemory row = insert(context.organizationId(), context.userId(), agent.getId(), kind, stored, "remember");
    syncFilesQuietly(agent);
    return toView(row);
  }

  public void captureRememberPhrase(OrganizationContext context, Agent agent, String content) {
    rememberPayload(content).ifPresent(payload -> {
      try {
        insert(
            context.organizationId(),
            context.userId(),
            agent.getId(),
            inferKind(payload),
            payload,
            "remember");
        syncFilesQuietly(agent);
      } catch (RuntimeException error) {
        log.warn("Failed to persist an explicit remember phrase for agent {}: {}", agent.getId(), error.getMessage());
      }
    });
  }

  public boolean hasPendingExtract(Agent agent) {
    if (agent == null) {
      return false;
    }
    Instant since = agents.findSettings(agent.getId())
        .map(AgentSettings::getMemoryExtractedAt)
        .orElse(Instant.EPOCH);
    return !agents.listUserMessagesSince(agent.getId(), since, 1).isEmpty();
  }

  public void consolidateAsync(Agent agent) {
    Thread.ofVirtual().start(() -> consolidateIfDue(agent));
  }

  public void consolidateIfDue(Agent agent) {
    if (agent == null) {
      return;
    }
    Object lock = extractLocks.computeIfAbsent(agent.getId(), id -> new Object());
    synchronized (lock) {
      if (!sockets.isConnected(agent.getId())) {
        return;
      }
      Instant since = agents.findSettings(agent.getId())
          .map(AgentSettings::getMemoryExtractedAt)
          .orElse(Instant.EPOCH);
      List<AgentMessage> messages = agents.listUserMessagesSince(agent.getId(), since, EXTRACT_MESSAGE_LIMIT);
      if (messages.isEmpty()) {
        return;
      }
      try {
        List<AgentMemory> active = memories.listActive(agent.getOrganizationId(), agent.getUserId());
        List<String> forgotten = Optional.ofNullable(
                memories.listForgottenContents(agent.getOrganizationId(), agent.getUserId()))
            .orElse(List.of());
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("userMessages", messages.stream().map(this::clipUserMessage).toList());
        payload.put("existing", active.stream().map(AgentMemoryService::extractHint).toList());
        payload.put("forgotten", forgotten.stream().limit(FORGOTTEN_HINT_LIMIT).toList());
        Map<String, Object> result = sockets.requestCommand(
            agent.getId(), "memory.extract", payload, Duration.ofSeconds(75));
        if (isExtractSkipped(result)) {
          log.warn("Memory consolidation skipped for agent {}: worker had no model", agent.getId());
          return;
        }
        persistExtracted(agent, active, forgotten, result);
        syncFilesQuietly(agent);
        lastMessageTime(messages).ifPresent(extractedAt ->
            agents.touchMemoryExtracted(agent.getId(), agent.getOrganizationId(), extractedAt));
      } catch (RuntimeException error) {
        log.warn("Memory consolidation skipped for agent {}: {}", agent.getId(), error.getMessage());
      }
    }
  }

  public MemoryFiles renderFiles(String organizationId, String userId) {
    List<AgentMemory> active = memories.listActive(organizationId, userId);
    return new MemoryFiles(renderMarkdown("User", preferences(active)), renderMarkdown("Memory", facts(active)));
  }

  private AgentMemory insert(
      String organizationId, String userId, String agentId, String kind, String content, String source) {
    if (isDuplicate(content, memories.listActive(organizationId, userId))) {
      throw ApiException.invalidRequest("An equivalent memory already exists");
    }
    Instant now = Instant.now();
    AgentMemory row = new AgentMemory();
    row.setId(UUID.randomUUID().toString());
    row.setOrganizationId(organizationId);
    row.setUserId(userId);
    row.setAgentId(agentId);
    row.setKind(kind);
    row.setSource(source);
    row.setContent(content);
    row.setCreatedAt(now);
    row.setUpdatedAt(now);
    memories.insert(row);
    return row;
  }

  private void persistExtracted(
      Agent agent, List<AgentMemory> active, List<String> forgotten, Map<String, Object> result) {
    List<Map<String, Object>> items = Optional.ofNullable(result.get("items"))
        .map(value -> mapper.convertValue(value, new TypeReference<List<Map<String, Object>>>() {}))
        .orElse(List.of());
    for (Map<String, Object> item : items) {
      Optional<String> content = textValue(item.get("content")).map(AgentMemoryService::normalizeContent);
      if (content.isEmpty() || content.get().length() > MAX_CONTENT_CHARS) {
        continue;
      }
      String kind = inferOrRequireKind(textValue(item.get("kind")), content.get());
      if (isDuplicate(content.get(), active) || isForgotten(content.get(), forgotten)) {
        continue;
      }
      try {
        AgentMemory created = insert(
            agent.getOrganizationId(), agent.getUserId(), agent.getId(), kind, content.get(), "extract");
        active.add(created);
      } catch (RuntimeException ignored) {
        // skip one bad extract item
      }
    }
  }

  private void syncFilesQuietly(Agent agent) {
    Runnable sync = () -> Thread.ofVirtual().start(() -> syncFilesNow(agent));
    if (TransactionSynchronizationManager.isSynchronizationActive()) {
      TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {
          sync.run();
        }
      });
      return;
    }
    sync.run();
  }

  private void syncFilesNow(Agent agent) {
    try {
      if (sockets.isConnected(agent.getId())) {
        MemoryFiles files = renderFiles(agent.getOrganizationId(), agent.getUserId());
        sockets.requestCommand(
            agent.getId(),
            "workspace.write",
            Map.of("path", "USER.md", "content", files.userMarkdown()),
            Duration.ofSeconds(15));
        sockets.requestCommand(
            agent.getId(),
            "workspace.write",
            Map.of("path", "MEMORY.md", "content", files.memoryMarkdown()),
            Duration.ofSeconds(15));
      }
    } catch (RuntimeException error) {
      log.warn("Failed to sync memory files for agent {}: {}", agent.getId(), error.getMessage());
    }
  }

  private String resolveRememberContent(
      OrganizationContext context, Agent agent, Optional<RememberMemoryRequest> request) {
    Optional<String> inline = request.map(RememberMemoryRequest::content).flatMap(AgentMemoryService::optionalText);
    if (inline.isPresent()) {
      return requireContent(inline);
    }
    String conversationId = request.map(RememberMemoryRequest::conversationId)
        .flatMap(AgentMemoryService::optionalText)
        .orElseThrow(() -> ApiException.invalidRequest("Message content is required"));
    Optional<String> messageId = request.map(RememberMemoryRequest::messageId)
        .flatMap(AgentMemoryService::optionalText);
    AgentMessage message = messageId
        .flatMap(id -> agents.findMessage(context.organizationId(), id))
        .or(() -> latestUserMessage(context.organizationId(), conversationId))
        .orElseThrow(() -> ApiException.notFound("Message"));
    if (!agent.getId().equals(message.getAgentId()) || !conversationId.equals(message.getConversationId())) {
      throw ApiException.notFound("Message");
    }
    if (!"user".equals(message.getRole())) {
      throw ApiException.invalidRequest("Only user messages can be remembered");
    }
    return requireContent(Optional.ofNullable(message.getContent()));
  }

  private Optional<AgentMessage> latestUserMessage(String organizationId, String conversationId) {
    return agents.listMessages(organizationId, conversationId, 50).stream()
        .filter(item -> "user".equals(item.getRole()))
        .reduce((first, second) -> second);
  }

  private String clipUserMessage(AgentMessage message) {
    String content = Optional.ofNullable(message.getContent()).orElse("").replaceAll("\\s+", " ").trim();
    if (content.length() <= EXTRACT_MESSAGE_CLIP) {
      return content;
    }
    return content.substring(0, EXTRACT_MESSAGE_CLIP);
  }

  static Optional<String> rememberPayload(String content) {
    String text = Optional.ofNullable(content).orElse("").trim();
    if (text.isEmpty()) {
      return Optional.empty();
    }
    for (Pattern pattern : List.of(REMEMBER_HELP, REMEMBER_PLEASE, REMEMBER_ENGLISH)) {
      Matcher matcher = pattern.matcher(text);
      if (matcher.matches()) {
        return optionalText(matcher.group(1));
      }
    }
    return Optional.empty();
  }

  private static boolean isExtractSkipped(Map<String, Object> result) {
    Object skipped = result.get("skipped");
    return Boolean.TRUE.equals(skipped) || "true".equals(String.valueOf(skipped));
  }

  private static Optional<Instant> lastMessageTime(List<AgentMessage> messages) {
    if (messages.isEmpty()) {
      return Optional.empty();
    }
    return Optional.ofNullable(messages.get(messages.size() - 1).getCreatedAt());
  }

  static String inferKind(String content) {
    return PREFERENCE_HINT.matcher(content).find() ? "preference" : "fact";
  }

  static String renderMarkdown(String title, List<AgentMemory> items) {
    StringBuilder body = new StringBuilder();
    body.append("# ").append(title).append('\n');
    if (items.isEmpty()) {
      body.append('\n');
      return body.toString();
    }
    body.append('\n');
    for (AgentMemory item : items) {
      body.append("- ").append(item.getContent().replace('\n', ' ').trim()).append('\n');
    }
    return body.toString();
  }

  static String clipBudget(String content, int budget) {
    if (content.length() <= budget) {
      return content;
    }
    return content.substring(0, Math.max(0, budget - 1)).trim() + "…";
  }

  private static List<AgentMemory> preferences(List<AgentMemory> items) {
    return items.stream().filter(item -> "preference".equals(item.getKind())).toList();
  }

  private static List<AgentMemory> facts(List<AgentMemory> items) {
    return items.stream().filter(item -> "fact".equals(item.getKind())).toList();
  }

  private static boolean isDuplicate(String content, List<AgentMemory> existing) {
    String normalized = normalizeKey(content);
    return existing.stream().anyMatch(item -> normalizeKey(item.getContent()).equals(normalized));
  }

  private static boolean isForgotten(String content, List<String> forgotten) {
    String normalized = normalizeKey(content);
    return forgotten.stream().anyMatch(item -> normalizeKey(item).equals(normalized));
  }

  private static String normalizeKey(String content) {
    return Optional.ofNullable(content).orElse("").replaceAll("\\s+", " ").trim().toLowerCase(Locale.ROOT);
  }

  private static String normalizeContent(String content) {
    return content.replaceAll("\\s+", " ").trim();
  }

  private static String requireKind(Optional<String> kind) {
    String value = kind.map(String::trim).map(item -> item.toLowerCase(Locale.ROOT)).orElse("");
    if (!List.of("preference", "fact").contains(value)) {
      throw ApiException.invalidRequest("kind must be preference or fact");
    }
    return value;
  }

  private static String inferOrRequireKind(Optional<String> kind, String content) {
    return kind.filter(value -> List.of("preference", "fact").contains(value)).orElseGet(() -> inferKind(content));
  }

  private static String requireContent(Optional<String> content) {
    String value = content.map(AgentMemoryService::normalizeContent).orElse("");
    if (value.isEmpty()) {
      throw ApiException.invalidRequest("Memory content is required");
    }
    if (value.length() > MAX_CONTENT_CHARS) {
      throw ApiException.invalidRequest("Memory content is too long");
    }
    return value;
  }

  private static Optional<String> optionalText(String value) {
    return Optional.ofNullable(value).map(String::trim).filter(item -> !item.isEmpty());
  }

  private static Optional<String> textValue(Object value) {
    return Optional.ofNullable(value).map(Object::toString).flatMap(AgentMemoryService::optionalText);
  }

  private static Map<String, String> extractHint(AgentMemory row) {
    Map<String, String> hint = new LinkedHashMap<>();
    hint.put("kind", row.getKind());
    hint.put("content", row.getContent());
    return hint;
  }

  private static MemoryView toView(AgentMemory row) {
    return new MemoryView(
        row.getId(),
        row.getKind(),
        row.getSource(),
        row.getContent(),
        row.getCreatedAt(),
        row.getUpdatedAt());
  }

  public record MemoryFiles(String userMarkdown, String memoryMarkdown) {}
}
