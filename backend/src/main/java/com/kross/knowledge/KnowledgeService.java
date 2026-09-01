package com.kross.knowledge;

import com.kross.api.ApiException;
import com.kross.api.PageResponse;
import com.kross.config.KrossProperties;
import com.kross.identity.AuthService;
import com.kross.identity.Identity;
import com.kross.identity.IdentityMapper;
import com.kross.identity.OrganizationAccess;
import com.kross.identity.OrganizationAction;
import com.kross.knowledge.dto.KnowledgeDocumentView;
import com.kross.knowledge.dto.KnowledgeJobView;
import com.kross.knowledge.dto.KnowledgeSearchRequest;
import com.kross.knowledge.dto.KnowledgeSearchView;
import com.kross.knowledge.dto.KnowledgeStatusView;
import com.kross.knowledge.dto.KnowledgeViews;
import com.kross.knowledge.entity.KnowledgeDocument;
import com.kross.knowledge.entity.KnowledgeJob;
import com.kross.storage.ObjectStorage;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

@Service
@RequiredArgsConstructor
public class KnowledgeService {
  public static final String PLATFORM_SPACE_ID = "platform";
  public static final int DEFAULT_TOP_K = 8;
  private static final int MAX_TEXT_BYTES = 2 * 1024 * 1024;
  private static final int MAX_BINARY_BYTES = 10 * 1024 * 1024;
  private static final Set<String> MARKDOWN_TYPES = Set.of(
      "text/markdown", "text/plain", "text/x-markdown");
  private static final Set<String> IMAGE_TYPES = Set.of(
      "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp");
  private static final Set<String> IMAGE_SUFFIXES = Set.of(".png", ".jpg", ".jpeg", ".gif", ".webp");
  private static final Set<String> PDF_TYPES = Set.of("application/pdf");
  private static final Set<String> WORD_TYPES = Set.of(
      "application/msword",
      "application/vnd.ms-word",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  private final KnowledgeMapper documents;
  private final KnowledgeClient client;
  private final IdentityMapper identities;
  private final OrganizationAccess access;
  private final AuthService auth;
  private final KrossProperties properties;
  private final ObjectStorage storage;

  public KnowledgeStatusView status(String organizationId) {
    access.require(organizationId, OrganizationAction.AGENT_READ);
    boolean available = available();
    boolean enabled = enabled();
    return new KnowledgeStatusView(
        enabled,
        available,
        enabled ? searchableSpaceIds(organizationId) : List.of());
  }

  public KnowledgeSearchView search(String organizationId, KnowledgeSearchRequest request) {
    access.require(organizationId, OrganizationAction.AGENT_READ);
    String query = Optional.ofNullable(request).map(KnowledgeSearchRequest::query).map(String::trim)
        .filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("query is required"));
    int topK = Optional.ofNullable(request).map(KnowledgeSearchRequest::topK).orElse(DEFAULT_TOP_K);
    return searchPublished(organizationId, query, topK);
  }

  public KnowledgeSearchView searchPublished(String organizationId, String query, int topK) {
    requireEnabled();
    String trimmed = Optional.ofNullable(query).map(String::trim).filter(value -> !value.isBlank())
        .orElseThrow(() -> ApiException.invalidRequest("query is required"));
    List<String> spaceIds = searchableSpaceIds(organizationId);
    if (spaceIds.isEmpty()) {
      return new KnowledgeSearchView(List.of());
    }
    return client.search(trimmed, spaceIds, Math.min(Math.max(topK, 1), 20));
  }

  public PageResponse<KnowledgeDocumentView> listDocuments(int page, int pageSize) {
    auth.requireSuperAdmin();
    requireAvailable();
    int size = Math.min(Math.max(pageSize, 1), 100);
    int current = Math.max(page, 1);
    int offset = (current - 1) * size;
    return new PageResponse<>(
        documents.listDocuments(PLATFORM_SPACE_ID, size, offset).stream().map(KnowledgeViews::document).toList(),
        current,
        size,
        documents.countDocuments(PLATFORM_SPACE_ID));
  }

  @Transactional
  public KnowledgeDocumentView ingest(String title, MultipartFile file) {
    auth.requireSuperAdmin();
    requireAvailable();
    Identity identity = access.currentIdentity();
    MultipartFile upload = Optional.ofNullable(file)
        .orElseThrow(() -> ApiException.invalidRequest("document file is required"));
    String filename = Optional.ofNullable(upload.getOriginalFilename()).map(String::trim).filter(value -> !value.isBlank())
        .orElse("document.md");
    String mime = Optional.ofNullable(upload.getContentType()).orElse("application/octet-stream");
    boolean image = isImage(filename, mime);
    boolean binary = image || isPdf(filename, mime) || isWord(filename, mime);
    if (!binary) {
      assertMarkdown(filename, mime);
    }
    byte[] bytes = readBytes(upload, binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES);
    KnowledgeDocument row = new KnowledgeDocument();
    row.setId(UUID.randomUUID().toString());
    row.setSpaceId(PLATFORM_SPACE_ID);
    row.setTitle(KnowledgeViews.titleOf(title, filename));
    row.setFilename(filename);
    row.setMime(mime);
    row.setStatus("processing");
    row.setCreatedBy(identity.userId());
    String sourceKey = sourceKey(row.getId(), filename);
    storage.putBytes(sourceKey, bytes, mime);
    row.setSourceKey(sourceKey);
    documents.insertDocument(row);

    KnowledgeJob job = new KnowledgeJob();
    job.setId(UUID.randomUUID().toString());
    job.setDocumentId(row.getId());
    job.setKind("ingest");
    job.setStatus("running");
    documents.insertJob(job);

    String text = binary ? "" : new String(bytes, StandardCharsets.UTF_8);
    String fileBase64 = binary ? Base64.getEncoder().encodeToString(bytes) : "";
    String imageBase64 = image ? fileBase64 : "";
    KnowledgeClient.IngestResult result = client.ingest(new KnowledgeClient.IngestPayload(
        row.getId(), PLATFORM_SPACE_ID, row.getTitle(), filename, mime, text, fileBase64, imageBase64,
        sourceKey));
    if (!"succeeded".equals(result.status())) {
      String message = Optional.ofNullable(result.errorMessage()).filter(value -> !value.isBlank())
          .orElse("Knowledge ingest failed");
      documents.updateJob(job.getId(), "failed", message);
      documents.updateDocumentStatus(row.getId(), "failed", message, false);
      return documents.findDocument(row.getId()).map(KnowledgeViews::document)
          .orElseThrow(() -> ApiException.notFound("Knowledge document"));
    }
    documents.updateJob(job.getId(), "succeeded", null);
    documents.updateDocumentStatus(row.getId(), "draft", null, false);
    return documents.findDocument(row.getId()).map(KnowledgeViews::document)
        .orElseThrow(() -> ApiException.notFound("Knowledge document"));
  }

  @Transactional
  public KnowledgeDocumentView publish(String documentId) {
    auth.requireSuperAdmin();
    requireAvailable();
    KnowledgeDocument row = documents.findDocument(documentId)
        .orElseThrow(() -> ApiException.notFound("Knowledge document"));
    if ("failed".equals(row.getStatus())) {
      throw ApiException.invalidRequest("Failed documents cannot be published");
    }
    client.publish(row.getId(), true);
    documents.updateDocumentStatus(row.getId(), "published", null, true);
    return documents.findDocument(row.getId()).map(KnowledgeViews::document)
        .orElseThrow(() -> ApiException.notFound("Knowledge document"));
  }

  public KnowledgeJobView job(String jobId) {
    auth.requireSuperAdmin();
    requireAvailable();
    return documents.findJob(jobId).map(KnowledgeViews::job)
        .orElseThrow(() -> ApiException.notFound("Knowledge job"));
  }

  public boolean available() {
    return properties.getKnowledge().isConfigured() && client.embeddingReady();
  }

  public boolean enabled() {
    return available() && identities.isKnowledgeEnabled();
  }

  private List<String> searchableSpaceIds(String organizationId) {
    String orgId = Optional.ofNullable(organizationId).map(String::trim).filter(value -> !value.isBlank()).orElse("");
    if (orgId.isBlank()) {
      return List.of(PLATFORM_SPACE_ID);
    }
    List<String> ids = Optional.ofNullable(documents.listSearchableSpaceIds(orgId)).orElse(List.of());
    return ids.isEmpty() ? List.of(PLATFORM_SPACE_ID) : List.copyOf(ids);
  }

  private void requireAvailable() {
    if (!available()) {
      throw new ApiException("knowledge_unavailable", "Knowledge service is not configured", 404);
    }
  }

  private void requireEnabled() {
    requireAvailable();
    if (!identities.isKnowledgeEnabled()) {
      throw new ApiException("knowledge_disabled", "Knowledge is disabled", 404);
    }
  }

  private static boolean isImage(String filename, String mime) {
    String type = mimeType(mime);
    String name = Optional.ofNullable(filename).orElse("").toLowerCase(Locale.ROOT);
    return IMAGE_TYPES.contains(type) || IMAGE_SUFFIXES.stream().anyMatch(name::endsWith);
  }

  private static boolean isPdf(String filename, String mime) {
    String type = mimeType(mime);
    String name = Optional.ofNullable(filename).orElse("").toLowerCase(Locale.ROOT);
    return PDF_TYPES.contains(type) || name.endsWith(".pdf");
  }

  private static boolean isWord(String filename, String mime) {
    String type = mimeType(mime);
    String name = Optional.ofNullable(filename).orElse("").toLowerCase(Locale.ROOT);
    return WORD_TYPES.contains(type) || name.endsWith(".doc") || name.endsWith(".docx");
  }

  private static void assertMarkdown(String filename, String mime) {
    String type = mimeType(mime);
    String name = filename.toLowerCase(Locale.ROOT);
    boolean markdownName = name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".txt");
    if (!markdownName && !MARKDOWN_TYPES.contains(type)) {
      throw ApiException.invalidRequest(
          "Only Markdown, PDF, Word (doc/docx), or images (png/jpeg/gif/webp) are supported");
    }
  }

  private static String mimeType(String mime) {
    return Optional.ofNullable(mime).orElse("").split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
  }

  private static String sourceKey(String documentId, String filename) {
    String safe = Optional.ofNullable(filename).orElse("file").replaceAll("[^A-Za-z0-9._-]", "_");
    if (safe.isBlank()) {
      safe = "file";
    }
    return "knowledge/" + PLATFORM_SPACE_ID + "/" + documentId + "/" + safe;
  }

  private static byte[] readBytes(MultipartFile file, int maxBytes) {
    if (file.getSize() > maxBytes) {
      throw ApiException.invalidRequest("Document is larger than the allowed size");
    }
    try {
      byte[] bytes = file.getBytes();
      if (bytes.length == 0) {
        throw ApiException.invalidRequest("Document is empty");
      }
      if (bytes.length > maxBytes) {
        throw ApiException.invalidRequest("Document is larger than the allowed size");
      }
      return bytes;
    } catch (ApiException error) {
      throw error;
    } catch (Exception error) {
      throw ApiException.invalidRequest("Failed to read document");
    }
  }
}
