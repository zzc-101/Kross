package com.kross.channel;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Component
public class ChannelEventBus {
  private static final long NO_TIMEOUT = 0L;
  private final ConcurrentHashMap<String, CopyOnWriteArrayList<SseEmitter>> subscribers =
      new ConcurrentHashMap<>();

  public SseEmitter subscribe(String conversationId) {
    SseEmitter emitter = new SseEmitter(NO_TIMEOUT);
    subscribers.computeIfAbsent(conversationId, key -> new CopyOnWriteArrayList<>()).add(emitter);
    Runnable drop = () -> remove(conversationId, emitter);
    emitter.onCompletion(drop);
    emitter.onTimeout(drop);
    emitter.onError(error -> drop.run());
    try {
      emitter.send(SseEmitter.event().comment("connected"));
    } catch (IOException error) {
      drop.run();
    }
    return emitter;
  }

  public void publish(ChannelEvent event) {
    CopyOnWriteArrayList<SseEmitter> emitters = subscribers.get(event.conversationId());
    if (emitters == null || emitters.isEmpty()) {
      return;
    }
    List<SseEmitter> dead = new ArrayList<>();
    for (SseEmitter emitter : emitters) {
      try {
        emitter.send(SseEmitter.event().name("channel").data(event, MediaType.APPLICATION_JSON));
      } catch (Exception error) {
        dead.add(emitter);
      }
    }
    dead.forEach(item -> remove(event.conversationId(), item));
  }

  private void remove(String conversationId, SseEmitter emitter) {
    CopyOnWriteArrayList<SseEmitter> emitters = subscribers.get(conversationId);
    if (emitters == null) {
      return;
    }
    emitters.remove(emitter);
    if (emitters.isEmpty()) {
      subscribers.remove(conversationId, emitters);
    }
  }
}
