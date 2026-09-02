package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Exercises PostgreSQL {@code FOR UPDATE SKIP LOCKED} — the uniqueness mechanism
 * behind {@code AgentMapper.claimJob}. Skipped unless {@code APP_IT_POSTGRES=1}.
 *
 * <p>Prerequisite: a reachable Postgres (Compose {@code postgres} is enough).
 * Optional overrides: {@code APP_IT_POSTGRES_URL}, {@code APP_IT_POSTGRES_USER},
 * {@code APP_IT_POSTGRES_PASSWORD} (defaults {@code jdbc:postgresql://127.0.0.1:5432/kross},
 * {@code kross}, and {@code APP_POSTGRES_PASSWORD} or {@code kross}).
 */
@EnabledIfEnvironmentVariable(named = "APP_IT_POSTGRES", matches = "1")
class AgentJobLeaseConcurrencyIT {
  @Test
  void skipLockedLetsOnlyOneSessionClaimTheRow() throws Exception {
    String url = env("APP_IT_POSTGRES_URL", "jdbc:postgresql://127.0.0.1:5432/kross");
    String user = env("APP_IT_POSTGRES_USER", "kross");
    String password = env("APP_IT_POSTGRES_PASSWORD", "kross");
    String table = "lease_it_" + UUID.randomUUID().toString().replace("-", "");
    try (Connection setup = DriverManager.getConnection(url, user, password);
         Statement ddl = setup.createStatement()) {
      ddl.execute("CREATE TABLE " + table + " (id text PRIMARY KEY, status text NOT NULL)");
      ddl.execute("INSERT INTO " + table + " VALUES ('job-1', 'queued')");
      CountDownLatch locked = new CountDownLatch(1);
      CountDownLatch release = new CountDownLatch(1);
      AtomicInteger claimed = new AtomicInteger();
      try {
        Thread holder = Thread.ofVirtual().start(
            () -> claim(url, user, password, table, locked, release, claimed));
        assertThat(locked.await(2, TimeUnit.SECONDS)).isTrue();
        claim(url, user, password, table, new CountDownLatch(0), new CountDownLatch(0), claimed);
        assertThat(claimed.get()).isEqualTo(1);
        release.countDown();
        holder.join();
        assertThat(claimed.get()).isEqualTo(1);
      } finally {
        ddl.execute("DROP TABLE IF EXISTS " + table);
      }
    }
  }

  private static void claim(
      String url,
      String user,
      String password,
      String table,
      CountDownLatch locked,
      CountDownLatch release,
      AtomicInteger claimed) {
    try (Connection connection = DriverManager.getConnection(url, user, password)) {
      connection.setAutoCommit(false);
      try (PreparedStatement select = connection.prepareStatement(
          "SELECT id FROM " + table + " WHERE status = 'queued' FOR UPDATE SKIP LOCKED LIMIT 1");
           ResultSet rows = select.executeQuery()) {
        locked.countDown();
        if (!rows.next()) {
          connection.rollback();
          return;
        }
        try (PreparedStatement update = connection.prepareStatement(
            "UPDATE " + table + " SET status = 'processing' WHERE id = ?")) {
          update.setString(1, rows.getString(1));
          update.executeUpdate();
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
    return Optional.ofNullable(System.getenv(name)).filter(value -> !value.isBlank()).orElse(fallback);
  }
}
