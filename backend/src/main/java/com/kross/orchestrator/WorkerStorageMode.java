package com.kross.orchestrator;

import com.kross.config.KrossProperties;
import java.nio.file.Files;
import java.util.Locale;
import java.util.Optional;

public enum WorkerStorageMode {
  LOCAL,
  JUICEFS;

  public static WorkerStorageMode from(String raw) {
    String value = Optional.ofNullable(raw).map(String::trim).filter(item -> !item.isBlank())
        .orElse("local")
        .toLowerCase(Locale.ROOT);
    return switch (value) {
      case "local" -> LOCAL;
      case "juicefs" -> JUICEFS;
      default -> throw new IllegalArgumentException("Unknown KROSS_WORKER_STORAGE: " + raw);
    };
  }

  public void validate(KrossProperties properties) {
    if (this != JUICEFS) {
      return;
    }
    var mount = WorkspacePaths.requireMount(properties);
    if (!Files.isDirectory(mount)) {
      throw new IllegalStateException(
          "JuiceFS mount not found: " + mount + ". Mount the filesystem on the host before starting workers.");
    }
  }
}
