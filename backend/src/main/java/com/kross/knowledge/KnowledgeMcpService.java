package com.kross.knowledge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.kross.agent.AgentTokenDirectory;
import com.kross.agent.entity.AgentSession;
import com.kross.api.ApiException;
import com.kross.config.AppProperties;
import com.kross.knowledge.dto.KnowledgeHitView;
import com.kross.knowledge.dto.KnowledgeSearchView;
import com.kross.support.Tokens;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

/**
 * Control-plane MCP facade for the managed knowledge search tool. Worker
 * authenticates with the existing agent token; space scope is resolved
 * server-side from the agent's organization and is never taken from the caller.
 */
@Service
@RequiredArgsConstructor
public class KnowledgeMcpService {
  public static final String SERVER_ID = "knowledge";
  public static final String TOOL_NAME = "knowledge_search";
  public static final String AGENT_TOKEN_ENV = "APP_AGENT_TOKEN";
  public static final String PROTOCOL_VERSION = "2025-11-25";

  private static final int PARSE_ERROR = -32700;
  private static final int INVALID_REQUEST = -32600;
  private static final int METHOD_NOT_FOUND = -32601;
  private static final int INVALID_PARAMS = -32602;
  private static final int INTERNAL_ERROR = -32603;

  private final KnowledgeService knowledge;
  private final AgentTokenDirectory tokenSessions;
  private final AppProperties properties;
  private final ObjectMapper mapper;

  public Optional<Map<String, Object>> managedServer() {
    if (!knowledge.enabled()) {
      return Optional.empty();
    }
    String base = Optional.ofNullable(properties.getPublicBaseUrl()).map(String::trim)
        .filter(value -> !value.isBlank())
        .orElse("http://127.0.0.1:8787");
    Map<String, Object> authorization = new LinkedHashMap<>();
    authorization.put("type", "bearer-env");
    authorization.put("env", AGENT_TOKEN_ENV);
    Map<String, Object> server = new LinkedHashMap<>();
    server.put("transport", "streamable-http");
    server.put("url", base.replaceAll("/+$", "") + "/mcp/knowledge");
    server.put("risk", "read");
    server.put("authorization", authorization);
    return Optional.of(server);
  }

  public ResponseEntity<JsonNode> dispatch(String authorization, JsonNode body) {
    AgentSession session = requireSession(authorization);
    if (body == null || body.isMissingNode() || body.isNull()) {
      return jsonRpcError(null, PARSE_ERROR, "Parse error");
    }
    if (!body.isObject()) {
      return jsonRpcError(null, INVALID_REQUEST, "Invalid Request");
    }
    if (!"2.0".equals(body.path("jsonrpc").asText())) {
      return jsonRpcError(idOf(body), INVALID_REQUEST, "Invalid Request");
    }
    if (!body.has("id")) {
      return ResponseEntity.accepted().build();
    }
    String method = Optional.ofNullable(body.path("method").asText(null)).orElse("");
    JsonNode id = idOf(body);
    JsonNode params = body.get("params");
    return switch (method) {
      case "initialize" -> jsonRpcResult(id, initializeResult());
      case "tools/list" -> jsonRpcResult(id, toolsListResult());
      case "tools/call" -> callTool(id, params, session);
      default -> jsonRpcError(id, METHOD_NOT_FOUND, "Method not found");
    };
  }

  private ResponseEntity<JsonNode> callTool(JsonNode id, JsonNode params, AgentSession session) {
    if (params != null && !params.isNull() && !params.isObject()) {
      return jsonRpcError(id, INVALID_PARAMS, "Invalid params");
    }
    JsonNode argsRoot = params == null ? mapper.missingNode() : params;
    String name = argsRoot.path("name").asText("");
    if (!TOOL_NAME.equals(name)) {
      return jsonRpcError(id, INVALID_PARAMS, "Unknown tool: " + name);
    }
    JsonNode arguments = argsRoot.path("arguments");
    if (arguments.isMissingNode() || arguments.isNull()) {
      arguments = mapper.createObjectNode();
    }
    if (!arguments.isObject()) {
      return jsonRpcError(id, INVALID_PARAMS, "Tool arguments must be an object");
    }
    String query = arguments.path("query").asText("").trim();
    if (query.isBlank()) {
      return jsonRpcError(id, INVALID_PARAMS, "query is required");
    }
    int topK = KnowledgeService.DEFAULT_TOP_K;
    JsonNode topKNode = arguments.get("topK");
    if (topKNode != null && !topKNode.isNull() && topKNode.isNumber()) {
      topK = topKNode.asInt();
    }
    String organizationId = Optional.ofNullable(session.getOrganizationId()).map(String::trim)
        .filter(value -> !value.isBlank())
        .orElseThrow(() -> new ApiException("agent_unauthenticated", "Invalid or expired agent token", 401));
    try {
      KnowledgeSearchView view = knowledge.searchPublished(organizationId, query, topK);
      return jsonRpcResult(id, toolResult(view));
    } catch (ApiException error) {
      if (error.getStatus() >= 400 && error.getStatus() < 500) {
        return jsonRpcError(id, INVALID_PARAMS, error.getMessage());
      }
      return jsonRpcError(id, INTERNAL_ERROR, error.getMessage());
    }
  }

  private ObjectNode initializeResult() {
    ObjectNode capabilities = mapper.createObjectNode();
    capabilities.set("tools", mapper.createObjectNode());
    ObjectNode serverInfo = mapper.createObjectNode();
    serverInfo.put("name", "kross-knowledge");
    serverInfo.put("version", "1.0.0");
    ObjectNode result = mapper.createObjectNode();
    result.put("protocolVersion", PROTOCOL_VERSION);
    result.set("capabilities", capabilities);
    result.set("serverInfo", serverInfo);
    return result;
  }

  private ObjectNode toolsListResult() {
    ObjectNode query = mapper.createObjectNode();
    query.put("type", "string");
    query.put("description", "检索语句");
    ObjectNode topK = mapper.createObjectNode();
    topK.put("type", "integer");
    topK.put("description", "返回条数，默认 " + KnowledgeService.DEFAULT_TOP_K + "，最大 20");
    ObjectNode properties = mapper.createObjectNode();
    properties.set("query", query);
    properties.set("topK", topK);
    ObjectNode inputSchema = mapper.createObjectNode();
    inputSchema.put("type", "object");
    inputSchema.set("properties", properties);
    ArrayNode required = mapper.createArrayNode();
    required.add("query");
    inputSchema.set("required", required);
    ObjectNode annotations = mapper.createObjectNode();
    annotations.put("readOnlyHint", true);
    ObjectNode tool = mapper.createObjectNode();
    tool.put("name", TOOL_NAME);
    tool.put("description", "检索当前组织可访问的已发布知识库文档。space 范围由控制面决定，不能由调用方指定。");
    tool.set("inputSchema", inputSchema);
    tool.set("annotations", annotations);
    ArrayNode tools = mapper.createArrayNode();
    tools.add(tool);
    ObjectNode result = mapper.createObjectNode();
    result.set("tools", tools);
    return result;
  }

  private ObjectNode toolResult(KnowledgeSearchView view) {
    List<KnowledgeHitView> hits = Optional.ofNullable(view).map(KnowledgeSearchView::hits).orElse(List.of());
    ObjectNode structured = mapper.createObjectNode();
    structured.set("hits", mapper.valueToTree(hits));
    ObjectNode contentItem = mapper.createObjectNode();
    contentItem.put("type", "text");
    contentItem.put("text", formatHits(hits));
    ArrayNode content = mapper.createArrayNode();
    content.add(contentItem);
    ObjectNode result = mapper.createObjectNode();
    result.set("content", content);
    result.set("structuredContent", structured);
    result.put("isError", false);
    return result;
  }

  private static String formatHits(List<KnowledgeHitView> hits) {
    if (hits.isEmpty()) {
      return "没有检索到已发布文档。";
    }
    return hits.stream()
        .map(hit -> {
          String title = Optional.ofNullable(hit.title()).filter(value -> !value.isBlank()).orElse("(untitled)");
          String excerpt = Optional.ofNullable(hit.excerpt()).orElse("");
          return title + " (score=" + hit.score() + ")\n" + excerpt;
        })
        .collect(Collectors.joining("\n\n"));
  }

  private AgentSession requireSession(String authorization) {
    String token = bearer(authorization)
        .orElseThrow(() -> new ApiException("agent_unauthenticated", "Invalid or expired agent token", 401));
    String calculated = Tokens.sha256Hex(token);
    AgentSession session = tokenSessions.findSession(calculated);
    if (session == null || !Tokens.hashEquals(calculated, session.getTokenHash())) {
      throw new ApiException("agent_unauthenticated", "Invalid or expired agent token", 401);
    }
    return session;
  }

  private static Optional<String> bearer(String authorization) {
    return Optional.ofNullable(authorization)
        .filter(value -> value.length() > 7 && value.regionMatches(true, 0, "Bearer ", 0, 7))
        .map(value -> value.substring(7).trim())
        .filter(value -> !value.isBlank());
  }

  private static JsonNode idOf(JsonNode body) {
    return body != null && body.has("id") ? body.get("id") : null;
  }

  private ResponseEntity<JsonNode> jsonRpcResult(JsonNode id, JsonNode result) {
    ObjectNode payload = mapper.createObjectNode();
    payload.put("jsonrpc", "2.0");
    setId(payload, id);
    payload.set("result", result);
    return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(payload);
  }

  private ResponseEntity<JsonNode> jsonRpcError(JsonNode id, int code, String message) {
    ObjectNode error = mapper.createObjectNode();
    error.put("code", code);
    error.put("message", Optional.ofNullable(message).orElse("Internal error"));
    ObjectNode payload = mapper.createObjectNode();
    payload.put("jsonrpc", "2.0");
    setId(payload, id);
    payload.set("error", error);
    return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(payload);
  }

  private static void setId(ObjectNode payload, JsonNode id) {
    if (id == null || id.isMissingNode()) {
      payload.putNull("id");
      return;
    }
    payload.set("id", id);
  }

  public static ResponseEntity<JsonNode> unauthorized() {
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
        .header(HttpHeaders.WWW_AUTHENTICATE, "Bearer")
        .build();
  }
}
