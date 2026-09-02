package com.kross.orchestrator;

import com.kross.config.AppProperties;
import java.nio.file.Path;
import java.util.Optional;

public final class WorkspacePaths {
  private WorkspacePaths() {}

  public static Path requireMount(AppProperties properties) {
    return Optional.ofNullable(properties.getJuicefsMount()).map(String::trim).filter(value -> !value.isBlank())
        .map(Path::of)
        .map(Path::toAbsolutePath)
        .map(Path::normalize)
        .orElseThrow(() -> new IllegalStateException("APP_JUICEFS_MOUNT is required when APP_WORKER_STORAGE=juicefs"));
  }

  public static Path agentDirectory(AppProperties properties, String agentId) {
    Path mount = requireMount(properties);
    Path directory = mount.resolve("agents").resolve(agentId).normalize();
    if (!directory.startsWith(mount)) {
      throw new IllegalArgumentException("Invalid agent workspace path");
    }
    return directory;
  }
}
