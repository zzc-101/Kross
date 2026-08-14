package com.kross.channel;

import java.util.Map;

public record ChannelEvent(
    String type,
    String conversationId,
    String messageId,
    Map<String, Object> data) {

  public static ChannelEvent of(
      String type, String conversationId, String messageId, Map<String, Object> data) {
    return new ChannelEvent(type, conversationId, messageId, data == null ? Map.of() : data);
  }
}
