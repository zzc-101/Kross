package com.kross.catalog;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import com.kross.storage.ObjectStorage;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class SkillPackageArtifactServiceTest {
  private ObjectStorage storage;
  private SkillPackageArtifactService service;

  @BeforeEach
  void setUp() {
    storage = mock(ObjectStorage.class);
    when(storage.head(anyString())).thenReturn(Optional.empty());
    service = new SkillPackageArtifactService(storage, new ObjectMapper());
  }

  @Test
  void storesCompleteSkillPackageAndDescribesCapabilities() throws Exception {
    byte[] zip = zip(Map.of(
        "office-skill/SKILL.md", "---\nname: office-skill\ndescription: Office helper\n---\n\nDo the work.",
        "office-skill/scripts/run.py", "print('ok')",
        "office-skill/references/guide.md", "Guide",
        "office-skill/assets/template.txt", "Template"));

    SkillPackageArtifactService.Artifact artifact = service.validateAndStore(zip);

    assertThat(artifact.skillMd()).contains("name: office-skill");
    assertThat(artifact.manifest().path("fileCount").asInt()).isEqualTo(4);
    assertThat(artifact.manifest().path("hasScripts").asBoolean()).isTrue();
    assertThat(artifact.manifest().path("hasReferences").asBoolean()).isTrue();
    assertThat(artifact.manifest().path("hasAssets").asBoolean()).isTrue();
    verify(storage).putBytes(artifact.key(), zip, "application/zip");
  }

  @Test
  void rejectsPackageWithoutRequiredFrontmatter() throws Exception {
    byte[] zip = zip(Map.of("SKILL.md", "Only instructions"));

    assertThatThrownBy(() -> service.validateAndStore(zip))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("frontmatter");
  }

  @Test
  void rejectsPathTraversal() throws Exception {
    Map<String, String> files = new LinkedHashMap<>();
    files.put("SKILL.md", "---\nname: safe\ndescription: Safe\n---\n");
    files.put("../escape.sh", "echo bad");

    assertThatThrownBy(() -> service.validateAndStore(zip(files)))
        .isInstanceOf(ApiException.class)
        .hasMessageContaining("traversal");
  }

  private static byte[] zip(Map<String, String> files) throws Exception {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
      for (Map.Entry<String, String> file : files.entrySet()) {
        zip.putNextEntry(new ZipEntry(file.getKey()));
        zip.write(file.getValue().getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
      }
    }
    return output.toByteArray();
  }
}
