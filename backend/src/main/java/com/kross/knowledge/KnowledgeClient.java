package com.kross.knowledge;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.kross.api.ApiException;
import com.kross.api.ApiHeaders;
import com.kross.config.AppProperties;
import com.kross.knowledge.dto.KnowledgeHitView;
import com.kross.knowledge.dto.KnowledgeSearchView;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Component;

@Component
public class KnowledgeClient {
  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper;
  private final AppProperties properties;

  public KnowledgeClient(ObjectMapper mapper, AppProperties properties) {
    this.mapper = mapper.copy().setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);
    this.properties = properties;
  }

  public boolean embeddingReady() {
    if (properties.getKnowledge().getBaseUrl().isEmpty()) {
      return false;
    }
    try {
      return Optional.ofNullable(get("/health", RemoteHealth.class).ready()).orElse(false);
    } catch (Exception error) {
      return false;
    }
  }

  public IngestResult ingest(IngestPayload payload) {
    RemoteIngestResponse response = post("/v1/ingest", payload, RemoteIngestResponse.class, Duration.ofSeconds(120));
    return new IngestResult(
        Optional.ofNullable(response.jobId()).orElse(""),
        Optional.ofNullable(response.status()).orElse("failed"),
        Optional.ofNullable(response.chunkCount()).orElse(0),
        response.errorMessage());
  }

  public void publish(String documentId, boolean published) {
    post("/v1/documents/" + documentId + "/publish", new RemotePublishPayload(published), RemotePublishResponse.class,
        Duration.ofSeconds(15));
  }

  public KnowledgeSearchView search(String query, List<String> spaceIds, int topK) {
    RemoteSearchResponse response = post(
        "/v1/search",
        new RemoteSearchPayload(query, spaceIds, topK, true),
        RemoteSearchResponse.class,
        Duration.ofSeconds(10));
    List<KnowledgeHitView> hits = Optional.ofNullable(response.hits()).orElse(List.of()).stream()
        .map(hit -> new KnowledgeHitView(
            hit.documentId(),
            hit.title(),
            hit.spaceId(),
            hit.excerpt(),
            hit.score(),
            Optional.ofNullable(hit.modality()).filter(value -> !value.isBlank()).orElse("text")))
        .toList();
    return new KnowledgeSearchView(hits);
  }

  public Optional<RemoteJobResponse> job(String jobId) {
    try {
      return Optional.of(get("/v1/jobs/" + jobId, RemoteJobResponse.class));
    } catch (ApiException error) {
      if (error.getStatus() == 404) {
        return Optional.empty();
      }
      throw error;
    }
  }

  private <T> T post(String path, Object body, Class<T> type, Duration timeout) {
    try {
      HttpRequest.Builder builder = HttpRequest.newBuilder(uri(path))
          .timeout(timeout)
          .header("accept", "application/json")
          .header("content-type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body), StandardCharsets.UTF_8));
      tokenHeader().ifPresent(token -> builder.header(ApiHeaders.KNOWLEDGE_TOKEN, token));
      HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() >= 400) {
        throw new ApiException("knowledge_upstream_failed", "Knowledge service rejected the request",
            mapStatus(response.statusCode()));
      }
      return mapper.readValue(response.body(), type);
    } catch (ApiException error) {
      throw error;
    } catch (Exception error) {
      throw new ApiException("knowledge_unavailable", "Knowledge service is unavailable", 502);
    }
  }

  private <T> T get(String path, Class<T> type) {
    try {
      HttpRequest.Builder builder = HttpRequest.newBuilder(uri(path))
          .timeout(Duration.ofSeconds(10))
          .header("accept", "application/json")
          .GET();
      tokenHeader().ifPresent(token -> builder.header(ApiHeaders.KNOWLEDGE_TOKEN, token));
      HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() == 404) {
        throw ApiException.notFound("Knowledge job");
      }
      if (response.statusCode() >= 400) {
        throw new ApiException("knowledge_upstream_failed", "Knowledge service rejected the request",
            mapStatus(response.statusCode()));
      }
      return mapper.readValue(response.body(), type);
    } catch (ApiException error) {
      throw error;
    } catch (Exception error) {
      throw new ApiException("knowledge_unavailable", "Knowledge service is unavailable", 502);
    }
  }

  private URI uri(String path) {
    String base = properties.getKnowledge().getBaseUrl()
        .orElseThrow(() -> new ApiException("knowledge_unavailable", "Knowledge service is not configured", 404));
    return URI.create(base.replaceAll("/+$", "") + path);
  }

  private Optional<String> tokenHeader() {
    return properties.getKnowledge().getInternalToken();
  }

  private static int mapStatus(int status) {
    if (status == 401 || status == 403) {
      return 502;
    }
    if (status == 404) {
      return 404;
    }
    if (status >= 400 && status < 500) {
      return 400;
    }
    return 502;
  }

  @JsonIgnoreProperties(ignoreUnknown = true)
  public record RemoteHealth(String status, Boolean ready, String reason, String embedding, String model, Integer dim) {}

  public record IngestPayload(
      String documentId,
      String spaceId,
      String title,
      String filename,
      String mime,
      String text,
      String fileBase64,
      String imageBase64,
      String sourceKey) {}

  public record IngestResult(String jobId, String status, int chunkCount, String errorMessage) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  public record RemoteIngestResponse(String documentId, String jobId, String status, Integer chunkCount,
      String errorMessage) {}

  public record RemotePublishPayload(boolean published) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  public record RemotePublishResponse(String documentId, boolean published, int chunkCount) {}

  public record RemoteSearchPayload(String query, List<String> spaceIds, int topK, boolean publishedOnly) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  public record RemoteSearchResponse(List<RemoteHit> hits) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  public record RemoteHit(
      String documentId, String title, String spaceId, String excerpt, double score, String modality) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  public record RemoteJobResponse(String id, String documentId, String kind, String status, String errorMessage) {}
}
