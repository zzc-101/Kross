package com.kross.agent;

import com.kross.agent.dto.AgentModelView;
import com.kross.agent.entity.AgentModel;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

/**
 * Cached view of usable model credentials. The cached records deliberately
 * exclude {@code secretCiphertext}: flows that need the decrypted secret
 * (model environment for worker jobs) always re-read the full row from the
 * database.
 */
@Service
@RequiredArgsConstructor
public class ModelCatalog {

  private final AgentMapper agents;

  public record UsableModel(String id, String name, String provider, String model, int contextWindow) {

    static UsableModel from(AgentModel row) {
      return new UsableModel(
          row.getId(),
          row.getName(),
          row.getProvider(),
          row.getModel(),
          row.getConfiguration() == null ? 256_000 : row.getConfiguration().path("contextWindow").asInt(256_000));
    }

    public AgentModelView toView() {
      return new AgentModelView(id, name, provider, model, contextWindow);
    }
  }

  @Cacheable(cacheNames = "modelList", key = "'all'", unless = "#result == null")
  public List<UsableModel> listUsable() {
    return agents.listUsableModels().stream()
        .map(UsableModel::from)
        .toList();
  }

  /** Returns the first usable model in creation order, or {@code null}. */
  public Optional<String> defaultModelId() {
    List<UsableModel> all = listUsable();
    return all.isEmpty() ? Optional.empty() : Optional.of(all.getFirst().id());
  }

  @Cacheable(cacheNames = "models", key = "#modelId", unless = "#result == null")
  public UsableModel findUsable(String modelId) {
    return agents.findUsableModelById(modelId)
        .map(UsableModel::from)
        .orElse(null);
  }
}
