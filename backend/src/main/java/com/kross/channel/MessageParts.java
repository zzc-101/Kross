package com.kross.channel;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Optional;

public final class MessageParts {
  private MessageParts() {}

  public static ArrayNode empty(ObjectMapper mapper) {
    return mapper.createArrayNode();
  }

  public static ArrayNode copyOrEmpty(ObjectMapper mapper, JsonNode parts) {
    if (parts != null && parts.isArray()) {
      return parts.deepCopy();
    }
    return empty(mapper);
  }

  public static void appendText(ArrayNode parts, String text) {
    if (text == null || text.isEmpty()) {
      return;
    }
    if (parts.size() > 0) {
      JsonNode last = parts.get(parts.size() - 1);
      if ("text".equals(last.path("type").asText()) && last instanceof ObjectNode object) {
        object.put("text", last.path("text").asText("") + text);
        return;
      }
    }
    ObjectNode part = parts.addObject();
    part.put("type", "text");
    part.put("text", text);
  }

  public static void appendReasoning(ArrayNode parts, String text) {
    if (text == null || text.isEmpty()) {
      return;
    }
    if (parts.size() > 0) {
      JsonNode last = parts.get(parts.size() - 1);
      if ("reasoning".equals(last.path("type").asText()) && last instanceof ObjectNode object) {
        object.put("text", last.path("text").asText("") + text);
        return;
      }
    }
    ObjectNode part = parts.addObject();
    part.put("type", "reasoning");
    part.put("text", text);
  }

  public static void upsertToolCall(
      ObjectMapper mapper, ArrayNode parts, String id, String name, Object input) {
    ObjectNode existing = findTool(parts, id);
    if (existing != null) {
      if (name != null && !name.isBlank()) {
        existing.put("name", name);
      }
      if (!existing.hasNonNull("status")) {
        existing.put("status", "running");
      }
      return;
    }
    ObjectNode part = parts.addObject();
    part.put("type", "tool");
    part.put("id", Optional.ofNullable(id).orElse(""));
    part.put("name", Optional.ofNullable(name).filter(value -> !value.isBlank()).orElse("tool"));
    part.put("status", "running");
    if (input != null) {
      part.set("input", mapper.valueToTree(input));
    }
  }

  public static void completeTool(ArrayNode parts, String id, String name, String content, boolean ok) {
    ObjectNode existing = findTool(parts, id);
    if (existing == null) {
      existing = parts.addObject();
      existing.put("type", "tool");
      existing.put("id", Optional.ofNullable(id).orElse(""));
      existing.put("name", Optional.ofNullable(name).filter(value -> !value.isBlank()).orElse("tool"));
    }
    existing.put("status", ok ? "done" : "failed");
    if (name != null && !name.isBlank()) {
      existing.put("name", name);
    }
    if (content != null) {
      existing.put("result", content);
    }
  }

  public static void appendFile(ArrayNode parts, String path, String mimeType, String name) {
    ObjectNode part = parts.addObject();
    part.put("type", "file");
    part.put("path", path);
    part.put("mimeType", Optional.ofNullable(mimeType).orElse("application/octet-stream"));
    part.put("name", Optional.ofNullable(name).filter(value -> !value.isBlank()).orElse(path));
  }

  public static String textSnapshot(JsonNode parts) {
    if (parts == null || !parts.isArray()) {
      return "";
    }
    StringBuilder text = new StringBuilder();
    parts.forEach(part -> {
      if ("text".equals(part.path("type").asText())) {
        String value = part.path("text").asText("");
        if (!value.isEmpty()) {
          if (text.length() > 0) {
            text.append('\n');
          }
          text.append(value);
        }
      }
    });
    return text.toString();
  }

  private static ObjectNode findTool(ArrayNode parts, String id) {
    if (id == null || id.isBlank()) {
      return null;
    }
    for (JsonNode part : parts) {
      if ("tool".equals(part.path("type").asText())
          && id.equals(part.path("id").asText())
          && part instanceof ObjectNode object) {
        return object;
      }
    }
    return null;
  }
}
