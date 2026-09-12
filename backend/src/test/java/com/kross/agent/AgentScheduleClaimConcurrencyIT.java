package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Two sessions cannot claim the same due schedule row and insert two runs.
 * Uses the same {@code SELECT ... FOR UPDATE SKIP LOCKED} + advance + insert-run
 * shape as {@code AgentScheduleMapper}. Skipped unless {@code APP_IT_POSTGRES=1}.
 */
@EnabledIfEnvironmentVariable(named = "APP_IT_POSTGRES", matches = "1")
class AgentScheduleClaimConcurrencyIT {
  @Test
  void skipLockedLetsOnlyOneSessionInsertARun() throws Exception {
    String url = env("APP_IT_POSTGRES_URL", "jdbc:postgresql://127.0.0.1:5432/kross");
    String user = env("APP_IT_POSTGRES_USER", "kross");
    String password = env("APP_IT_POSTGRES_PASSWORD", "kross");
    String suffix = UUID.randomUUID().toString().replace("-", "");
    String schedules = "schedule_it_" + suffix;
    String runs = "schedule_run_it_" + suffix;
    try (Connection setup = DriverManager.getConnection(url, user, password);
         Statement ddl = setup.createStatement()) {
      ddl.execute("CREATE TABLE " + schedules
          + " (id text PRIMARY KEY, status text NOT NULL, next_run_at timestamptz, last_run_at timestamptz,"
          + " consecutive_failures integer NOT NULL DEFAULT 0, updated_at timestamptz)");
      ddl.execute("CREATE TABLE " + runs
          + " (id text PRIMARY KEY, schedule_id text NOT NULL, organization_id text NOT NULL,"
          + " due_at timestamptz NOT NULL, claimed_at timestamptz NOT NULL, status text NOT NULL)");
      ddl.execute("INSERT INTO " + schedules + " VALUES ('sched-1', 'active', now() - interval '1 minute', NULL, 0, now())");
      CountDownLatch locked = new CountDownLatch(1);
      CountDownLatch release = new CountDownLatch(1);
      AtomicInteger claimed = new AtomicInteger();
      try {
        Thread holder = Thread.ofVirtual().start(
            () -> claim(url, user, password, schedules, runs, locked, release, claimed));
        assertThat(locked.await(2, TimeUnit.SECONDS)).isTrue();
        claim(url, user, password, schedules, runs, new CountDownLatch(0), new CountDownLatch(0), claimed);
        assertThat(claimed.get()).isEqualTo(1);
        release.countDown();
        holder.join();
        assertThat(claimed.get()).isEqualTo(1);
        try (ResultSet rows = ddl.executeQuery("SELECT count(*) FROM " + runs + " WHERE schedule_id = 'sched-1'")) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getInt(1)).isEqualTo(1);
        }
      } finally {
        ddl.execute("DROP TABLE IF EXISTS " + runs);
        ddl.execute("DROP TABLE IF EXISTS " + schedules);
      }
    }
  }

  private static void claim(
      String url,
      String user,
      String password,
      String schedules,
      String runs,
      CountDownLatch locked,
      CountDownLatch release,
      AtomicInteger claimed) {
    try (Connection connection = DriverManager.getConnection(url, user, password)) {
      connection.setAutoCommit(false);
      try (PreparedStatement select = connection.prepareStatement(
          "SELECT * FROM " + schedules
              + " WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= now()"
              + " ORDER BY next_run_at ASC, id ASC FOR UPDATE SKIP LOCKED LIMIT 1");
           ResultSet rows = select.executeQuery()) {
        locked.countDown();
        if (!rows.next()) {
          connection.rollback();
          return;
        }
        String id = rows.getString("id");
        try (PreparedStatement update = connection.prepareStatement(
            "UPDATE " + schedules
                + " SET next_run_at = now() + interval '1 hour', last_run_at = now(), updated_at = now()"
                + " WHERE id = ? AND status = 'active'")) {
          update.setString(1, id);
          if (update.executeUpdate() == 0) {
            connection.rollback();
            return;
          }
        }
        try (PreparedStatement insert = connection.prepareStatement(
            "INSERT INTO " + runs
                + " (id, schedule_id, organization_id, due_at, claimed_at, status)"
                + " VALUES (?, ?, 'org-1', now(), now(), 'started')")) {
          insert.setString(1, UUID.randomUUID().toString());
          insert.setString(2, id);
          insert.executeUpdate();
        }
        claimed.incrementAndGet();
        if (release.getCount() > 0) {
          release.await(2, TimeUnit.SECONDS);
        }
        connection.commit();
      }
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }

  private static String env(String name, String fallback) {
    String value = System.getenv(name);
    if (value != null && !value.isBlank()) {
      return value;
    }
    if ("APP_IT_POSTGRES_PASSWORD".equals(name)) {
      String password = System.getenv("APP_POSTGRES_PASSWORD");
      if (password != null && !password.isBlank()) {
        return password;
      }
    }
    return fallback;
  }
}
