package com.kross.agent;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class AgentJobLeaseSqlTest {
  @Test
  void claimAndRecoverUseSkipLocked() throws Exception {
    String xml;
    try (InputStream in = AgentMapper.class.getResourceAsStream("/mapper/AgentMapper.xml")) {
      assertThat(in).isNotNull();
      xml = new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
    String claim = slice(xml, "<select id=\"claimJob\"", "</select>");
    String recover = slice(xml, "<select id=\"recoverExpiredLeases\"", "</select>");

    assertThat(claim).containsIgnoringCase("FOR UPDATE SKIP LOCKED");
    assertThat(recover).containsIgnoringCase("FOR UPDATE SKIP LOCKED");
    assertThat(claim).contains("status = 'queued'");
    assertThat(recover).contains("lease_expires_at");
  }

  private static String slice(String xml, String start, String end) {
    int from = xml.indexOf(start);
    assertThat(from).isGreaterThanOrEqualTo(0);
    int to = xml.indexOf(end, from);
    assertThat(to).isGreaterThan(from);
    return xml.substring(from, to);
  }
}
