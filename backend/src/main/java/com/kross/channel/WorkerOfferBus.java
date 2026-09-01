package com.kross.channel;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * Offers a claimed job to the Worker that holds the WebSocket. The socket
 * table is per-process, so a replica that accepted the HTTP write may not
 * own the connection; Redis Pub/Sub wakes the replica that does. Redis
 * loss degrades to the local {@link AgentSocketHub#offerJob(String)} call.
 */
@Component
public class WorkerOfferBus {
  private final AgentSocketHub sockets;
  private final ClusterFanout fanout;

  public WorkerOfferBus(AgentSocketHub sockets, ObjectProvider<ClusterFanout> fanout) {
    this.sockets = sockets;
    this.fanout = fanout.getIfAvailable();
    Optional.ofNullable(this.fanout)
        .ifPresent(bus -> bus.on(ClusterFanout.WORKER_OFFER, this::onRemoteOffer));
  }

  public void offer(String agentId) {
    sockets.offerJob(agentId);
    Optional.ofNullable(fanout).ifPresent(bus ->
        bus.publish(ClusterFanout.WORKER_OFFER, Map.of("agentId", agentId)));
  }

  private void onRemoteOffer(JsonNode body) {
    Optional.ofNullable(body)
        .map(node -> node.path("agentId").asText(""))
        .map(String::trim)
        .filter(id -> !id.isEmpty())
        .ifPresent(sockets::offerJob);
  }
}
