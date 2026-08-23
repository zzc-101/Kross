package com.kross.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.kross.api.ApiException;
import com.kross.storage.ObjectStorage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class SkillPackageArtifactService {
  public static final long MAX_PACKAGE_BYTES = 10L * 1024 * 1024;
  private static final long MAX_UNCOMPRESSED_BYTES = 32L * 1024 * 1024;
  private static final long MAX_FILE_BYTES = 8L * 1024 * 1024;
  private static final int MAX_FILES = 256;

  private final ObjectStorage storage;
  private final ObjectMapper mapper;

  public Artifact validateAndStore(byte[] bytes) {
    if (bytes == null || bytes.length == 0) {
      throw ApiException.invalidRequest("Skill ZIP package is required");
    }
    if (bytes.length > MAX_PACKAGE_BYTES) {
      throw ApiException.invalidRequest("Skill ZIP package must not exceed 10 MB");
    }
    InspectedPackage inspected = inspect(bytes);
    String sha256 = digest(bytes);
    String key = "skills/sha256/" + sha256.substring(0, 2) + "/" + sha256 + ".zip";
    if (storage.head(key).isEmpty()) {
      storage.putBytes(key, bytes, "application/zip");
    }
    return new Artifact(key, sha256, bytes.length, inspected.skillMd(), inspected.manifest());
  }

  public Artifact storeLegacyPackage(String skillId, String name, String description, String skillMd) {
    String frontmatter = "---\nname: " + yamlScalar(skillId) + "\ndescription: "
        + yamlScalar(description == null || description.isBlank() ? name : description) + "\n---\n\n";
    try {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      try (ZipOutputStream zip = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
        zip.putNextEntry(new ZipEntry("SKILL.md"));
        zip.write((frontmatter + skillMd.trim() + "\n").getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
      }
      return validateAndStore(output.toByteArray());
    } catch (Exception error) {
      throw new IllegalStateException("Unable to package migrated Skill", error);
    }
  }

  private InspectedPackage inspect(byte[] bytes) {
    Set<String> names = new HashSet<>();
    String skillMd = null;
    String skillMdPath = null;
    int files = 0;
    long total = 0;
    boolean scripts = false;
    boolean references = false;
    boolean assets = false;
    try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8)) {
      ZipEntry entry;
      byte[] buffer = new byte[8192];
      while ((entry = zip.getNextEntry()) != null) {
        String path = safePath(entry.getName());
        if (entry.isDirectory()) continue;
        if (!names.add(path)) throw ApiException.invalidRequest("Skill ZIP contains duplicate paths");
        if (++files > MAX_FILES) throw ApiException.invalidRequest("Skill ZIP contains too many files");
        ByteArrayOutputStream file = new ByteArrayOutputStream();
        int read;
        long fileSize = 0;
        while ((read = zip.read(buffer)) >= 0) {
          fileSize += read;
          total += read;
          if (fileSize > MAX_FILE_BYTES) throw ApiException.invalidRequest("A Skill file exceeds 8 MB");
          if (total > MAX_UNCOMPRESSED_BYTES) {
            throw ApiException.invalidRequest("Skill ZIP expands beyond 32 MB");
          }
          file.write(buffer, 0, read);
        }
        scripts |= path.startsWith("scripts/") || path.matches("^[^/]+/scripts/.*");
        references |= path.startsWith("references/") || path.matches("^[^/]+/references/.*");
        assets |= path.startsWith("assets/") || path.matches("^[^/]+/assets/.*");
        if (path.equals("SKILL.md") || path.matches("^[^/]+/SKILL\\.md$")) {
          if (skillMd != null) throw ApiException.invalidRequest("Skill ZIP must contain exactly one root SKILL.md");
          skillMd = utf8(file.toByteArray());
          skillMdPath = path;
        }
      }
    } catch (ApiException error) {
      throw error;
    } catch (Exception error) {
      throw ApiException.invalidRequest("Invalid Skill ZIP package");
    }
    if (skillMd == null || skillMd.isBlank()) {
      throw ApiException.invalidRequest("Skill ZIP must contain a non-empty root SKILL.md");
    }
    validateFrontmatter(skillMd);
    ObjectNode manifest = mapper.createObjectNode();
    manifest.put("format", "agent-skill");
    manifest.put("skillMdPath", skillMdPath);
    manifest.put("fileCount", files);
    manifest.put("uncompressedSizeBytes", total);
    manifest.put("hasScripts", scripts);
    manifest.put("hasReferences", references);
    manifest.put("hasAssets", assets);
    ArrayNode directories = manifest.putArray("capabilities");
    if (scripts) directories.add("scripts");
    if (references) directories.add("references");
    if (assets) directories.add("assets");
    return new InspectedPackage(skillMd, manifest);
  }

  private static String safePath(String raw) {
    String path = raw == null ? "" : raw.replace('\\', '/');
    if (path.isBlank() || path.startsWith("/") || path.matches("^[A-Za-z]:.*")) {
      throw ApiException.invalidRequest("Skill ZIP contains an invalid path");
    }
    for (String part : path.split("/")) {
      if (part.equals("..") || part.equals(".")) {
        throw ApiException.invalidRequest("Skill ZIP path traversal is not allowed");
      }
    }
    return path;
  }

  private static String utf8(byte[] bytes) {
    try {
      return StandardCharsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes)).toString();
    } catch (CharacterCodingException error) {
      throw ApiException.invalidRequest("SKILL.md must be UTF-8 text");
    }
  }

  private static void validateFrontmatter(String content) {
    if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
      throw ApiException.invalidRequest("SKILL.md must start with YAML frontmatter");
    }
    int end = content.indexOf("\n---", 4);
    if (end < 0) throw ApiException.invalidRequest("SKILL.md frontmatter is not closed");
    String frontmatter = content.substring(4, end);
    if (!frontmatter.matches("(?ms).*?^name\\s*:\\s*\\S+.*")) {
      throw ApiException.invalidRequest("SKILL.md frontmatter must include name");
    }
    if (!frontmatter.matches("(?ms).*?^description\\s*:\\s*\\S+.*")) {
      throw ApiException.invalidRequest("SKILL.md frontmatter must include description");
    }
  }

  public static String digest(String content) {
    return digest(content.getBytes(StandardCharsets.UTF_8));
  }

  private static String digest(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (Exception error) {
      throw new IllegalStateException("Unable to digest Skill package", error);
    }
  }

  private static String yamlScalar(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  public record Artifact(
      String key, String sha256, long sizeBytes, String skillMd, JsonNode manifest) {}

  private record InspectedPackage(String skillMd, JsonNode manifest) {}
}
