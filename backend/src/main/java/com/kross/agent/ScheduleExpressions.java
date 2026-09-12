package com.kross.agent;

import com.cronutils.model.Cron;
import com.cronutils.model.CronType;
import com.cronutils.model.definition.CronDefinitionBuilder;
import com.cronutils.model.time.ExecutionTime;
import com.cronutils.parser.CronParser;
import com.kross.api.ApiException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Optional;

final class ScheduleExpressions {
  static final Duration MIN_INTERVAL = Duration.ofHours(1);
  private static final CronParser PARSER =
      new CronParser(CronDefinitionBuilder.instanceDefinitionFor(CronType.UNIX));

  private ScheduleExpressions() {}

  static ZoneId zone(String timezone) {
    try {
      return ZoneId.of(Optional.ofNullable(timezone).map(String::trim).filter(value -> !value.isBlank()).orElse("UTC"));
    } catch (RuntimeException error) {
      throw ApiException.invalidRequest("Invalid timezone");
    }
  }

  static String requireCron(String expr) {
    Cron cron = parse(expr);
    if (!intervalAtLeastHour(cron)) {
      throw ApiException.invalidRequest("Recurring schedules must be at least one hour apart");
    }
    return cron.asString();
  }

  static Instant nextCron(String expr, String timezone, Instant after) {
    ExecutionTime time = ExecutionTime.forCron(parse(expr));
    ZonedDateTime base = Optional.ofNullable(after).orElseGet(Instant::now).atZone(zone(timezone)).plusSeconds(1);
    return time.nextExecution(base)
        .map(ZonedDateTime::toInstant)
        .orElseThrow(() -> ApiException.invalidRequest("Schedule has no next run"));
  }

  static Instant parseRunAt(String raw, String timezone) {
    String value = Optional.ofNullable(raw).map(String::trim).filter(item -> !item.isEmpty())
        .orElseThrow(() -> ApiException.invalidRequest("runAt is required"));
    ZoneId zone = zone(timezone);
    try {
      if (value.endsWith("Z")) {
        return Instant.parse(value);
      }
      if (value.matches(".*[+-]\\d{2}:\\d{2}$")) {
        return OffsetDateTime.parse(value).toInstant();
      }
      return LocalDateTime.parse(value).atZone(zone).toInstant();
    } catch (RuntimeException error) {
      throw ApiException.invalidRequest("Invalid runAt");
    }
  }

  private static Cron parse(String expr) {
    String value = Optional.ofNullable(expr).map(String::trim).orElse("");
    if (value.isEmpty()) {
      throw ApiException.invalidRequest("cron is required");
    }
    try {
      Cron cron = PARSER.parse(value);
      cron.validate();
      return cron;
    } catch (RuntimeException error) {
      throw ApiException.invalidRequest("Invalid cron expression");
    }
  }

  private static boolean intervalAtLeastHour(Cron cron) {
    ExecutionTime time = ExecutionTime.forCron(cron);
    ZonedDateTime cursor = ZonedDateTime.of(2026, 1, 6, 0, 0, 30, 0, ZoneId.of("UTC"));
    Optional<ZonedDateTime> previous = time.nextExecution(cursor);
    if (previous.isEmpty()) {
      return false;
    }
    for (int i = 0; i < 30; i++) {
      Optional<ZonedDateTime> next = time.nextExecution(previous.get());
      if (next.isEmpty()) {
        return i > 0;
      }
      if (Duration.between(previous.get(), next.get()).minus(MIN_INTERVAL).isNegative()) {
        return false;
      }
      previous = next;
    }
    return true;
  }
}
