package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kross.api.ApiException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import org.junit.jupiter.api.Test;

class ScheduleExpressionsTest {
  @Test
  void acceptsHourlyAndDailyCron() {
    assertThat(ScheduleExpressions.requireCron("0 * * * *")).isEqualTo("0 * * * *");
    assertThat(ScheduleExpressions.requireCron("30 9 * * 1-5")).contains("30");
  }

  @Test
  void rejectsSubHourlyCron() {
    assertThatThrownBy(() -> ScheduleExpressions.requireCron("* * * * *"))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("one hour");
    assertThatThrownBy(() -> ScheduleExpressions.requireCron("0,30 * * * *"))
        .isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> ScheduleExpressions.requireCron("0,1 0 * * *"))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("one hour");
  }

  @Test
  void parseRunAtUsesTaskTimezone() {
    Instant expected = ZonedDateTime.of(2026, 9, 12, 9, 0, 0, 0, ZoneId.of("Asia/Tokyo")).toInstant();
    assertThat(ScheduleExpressions.parseRunAt("2026-09-12T09:00", "Asia/Tokyo")).isEqualTo(expected);
  }

  @Test
  void nextCronIsAfterTheBaseInstant() {
    Instant nine = ZonedDateTime.of(2026, 3, 1, 9, 0, 0, 0, ZoneId.of("Asia/Shanghai")).toInstant();
    Instant next = ScheduleExpressions.nextCron("0 9 * * *", "Asia/Shanghai", nine);
    assertThat(next).isAfter(nine);
  }

  @Test
  void rejectsInvalidTimezoneAndCron() {
    assertThatThrownBy(() -> ScheduleExpressions.zone("Not/AZone"))
        .isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> ScheduleExpressions.requireCron("not-a-cron"))
        .isInstanceOf(ApiException.class);
  }
}
