package com.kross.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.agent.dto.AgentProtocol;
import com.kross.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.util.List;

final class WorkerPayloadValidator {
  private static final int MAX_CONTENT_CHARS = 64_000;
  private static final int MAX_PARTS_BYTES = 512 * 1024;
  private static final int MAX_EVENTS = 100;
  private static final int MAX_EVENT_TEXT_CHARS = 32_000;
  private static final int MAX_EVENTS_BYTES = 256 * 1024;
  private static final int MAX_ERROR_SUMMARY_CHARS = 2_000;

  private WorkerPayloadValidator() {}

  static void validateReply(ObjectMapper mapper, AgentProtocol.ReplyRequest request) {
    requireLength(request.content(), MAX_CONTENT_CHARS, "Reply content");
    requireLength(request.errorSummary(), MAX_ERROR_SUMMARY_CHARS, "Error summary");
    requireJsonSize(mapper, request.parts(), MAX_PARTS_BYTES, "Reply parts");
  }

  static List<AgentProtocol.StreamEvent> validateEvents(
      ObjectMapper mapper, List<AgentProtocol.StreamEvent> input) {
    List<AgentProtocol.StreamEvent> events = input == null ? List.of() : input;
    if (events.size() > MAX_EVENTS) {
      throw ApiException.invalidRequest("Too many stream events");
    }
    for (AgentProtocol.StreamEvent event : events) {
      if (event == null) {
        continue;
      }
      requireLength(event.type(), 64, "Stream event type");
      requireLength(event.text(), MAX_EVENT_TEXT_CHARS, "Stream event text");
      requireLength(event.content(), MAX_EVENT_TEXT_CHARS, "Stream event content");
      requireLength(event.id(), 128, "Stream event id");
      requireLength(event.name(), 128, "Stream event name");
    }
    requireJsonSize(mapper, events, MAX_EVENTS_BYTES, "Stream events");
    return events;
  }

  private static void requireJsonSize(ObjectMapper mapper, Object value, int maxBytes, String label) {
    if (value != null
        && mapper.valueToTree(value).toString().getBytes(StandardCharsets.UTF_8).length > maxBytes) {
      throw ApiException.invalidRequest(label + " is too large");
    }
  }

  private static void requireLength(String value, int maxChars, String label) {
    if (value != null && value.length() > maxChars) {
      throw ApiException.invalidRequest(label + " is too large");
    }
  }
}
