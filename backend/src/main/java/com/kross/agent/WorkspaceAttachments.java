package com.kross.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.agent.dto.AgentProtocol;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

final class WorkspaceAttachments {
  private static final Set<String> VISION_MIME = Set.of(
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "image/webp");

  private WorkspaceAttachments() {}

  static List<AgentProtocol.WorkspaceImage> visionImages(JsonNode parts) {
    if (parts == null || !parts.isArray()) {
      return List.of();
    }
    List<AgentProtocol.WorkspaceImage> images = new ArrayList<>();
    parts.forEach(part -> {
      if (!"file".equals(part.path("type").asText())) {
        return;
      }
      String path = part.path("path").asText("").trim();
      String mime = part.path("mimeType").asText("").trim();
      String name = part.path("name").asText("").trim();
      if (path.isEmpty() || !isVision(mime, name.isEmpty() ? path : name)) {
        return;
      }
      images.add(new AgentProtocol.WorkspaceImage(path, normalizeMime(mime, name.isEmpty() ? path : name)));
    });
    return List.copyOf(images);
  }

  static String withAttachmentLine(String content, JsonNode parts) {
    List<String> paths = filePaths(parts);
    if (paths.isEmpty()) {
      return Optional.ofNullable(content).orElse("");
    }
    String line = "（附件：" + String.join("、", paths) + "）";
    String text = Optional.ofNullable(content).orElse("").trim();
    return text.isEmpty() ? line : text + "\n" + line;
  }

  static List<String> filePaths(JsonNode parts) {
    if (parts == null || !parts.isArray()) {
      return List.of();
    }
    List<String> paths = new ArrayList<>();
    parts.forEach(part -> {
      if ("file".equals(part.path("type").asText())) {
        String path = part.path("path").asText("").trim();
        if (!path.isEmpty()) {
          paths.add(path);
        }
      }
    });
    return List.copyOf(paths);
  }

  static boolean isVision(String mimeType, String filename) {
    String mime = Optional.ofNullable(mimeType).orElse("").trim().toLowerCase(Locale.ROOT);
    if (VISION_MIME.contains(mime)) {
      return true;
    }
    String name = Optional.ofNullable(filename).orElse("").toLowerCase(Locale.ROOT);
    return name.endsWith(".png")
        || name.endsWith(".jpg")
        || name.endsWith(".jpeg")
        || name.endsWith(".gif")
        || name.endsWith(".webp");
  }

  static String normalizeMime(String mimeType, String filename) {
    String mime = Optional.ofNullable(mimeType).orElse("").trim().toLowerCase(Locale.ROOT);
    if (VISION_MIME.contains(mime)) {
      return "image/jpg".equals(mime) ? "image/jpeg" : mime;
    }
    String name = Optional.ofNullable(filename).orElse("").toLowerCase(Locale.ROOT);
    if (name.endsWith(".png")) return "image/png";
    if (name.endsWith(".gif")) return "image/gif";
    if (name.endsWith(".webp")) return "image/webp";
    return "image/jpeg";
  }
}
