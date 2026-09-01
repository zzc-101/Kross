package com.kross.agent;

import com.kross.agent.dto.AgentViews;
import com.kross.agent.entity.AgentMessage;
import com.kross.channel.ChannelEvent;
import com.kross.channel.ChannelEventBus;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
class AgentChannelPublisher {
  private final ChannelEventBus channelEvents;
  private final AgentTransactions transactions;

  void emitUpsert(AgentMessage row) {
    Map<String, Object> data = new LinkedHashMap<>();
    data.put("message", AgentViews.message(row));
    emit(ChannelEvent.of("message.upsert", row.getConversationId(), row.getId(), data));
  }

  void emit(ChannelEvent event) {
    transactions.afterCommit(() -> channelEvents.publish(event));
  }
}
