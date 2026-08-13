package com.kross.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public final class Jsons {
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private Jsons() {}

  public static JsonNode objectOrEmpty(JsonNode node) {
    return node != null && node.isObject() ? node : MAPPER.createObjectNode();
  }

  public static List<String> stringList(JsonNode node) {
    if (node == null || node.isNull() || node.isMissingNode()) {
      return List.of();
    }
    if (node.isArray()) {
      List<String> values = new ArrayList<>();
      node.forEach(item -> {
        if (item != null && item.isTextual()) {
          values.add(item.asText());
        }
      });
      return List.copyOf(values);
    }
    return List.of();
  }

  public static Optional<String> text(JsonNode node, String field) {
    if (node == null || !node.hasNonNull(field)) {
      return Optional.empty();
    }
    String value = node.path(field).asText("").trim();
    return value.isBlank() ? Optional.empty() : Optional.of(value);
  }

  public static Instant instant(JsonNode node, String field) {
    return text(node, field).map(Instant::parse).orElse(null);
  }
}
