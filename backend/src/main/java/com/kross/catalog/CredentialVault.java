package com.kross.catalog;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Optional;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.kross.api.ApiException;
import com.kross.config.KrossProperties;
import org.springframework.stereotype.Component;

@Component
public class CredentialVault {
  private static final int IV_BYTES = 12;
  private static final String VERSION = "v1";
  private final byte[] key;
  private final ObjectMapper mapper = new ObjectMapper();
  private final SecureRandom random = new SecureRandom();

  public CredentialVault(KrossProperties properties) {
    String secret = Optional.ofNullable(properties.getCredentialMasterKey()).orElse("").trim();
    if (secret.length() < 32) {
      throw new ApiException(
          "credential_master_key_invalid",
          "Credential master key must be at least 32 characters",
          500);
    }
    try {
      this.key = MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8));
    } catch (GeneralSecurityException error) {
      throw new IllegalStateException(error);
    }
  }

  public String encrypt(String apiKey, Optional<String> baseUrl) {
    String trimmed = Optional.ofNullable(apiKey).orElse("").trim();
    if (trimmed.length() < 8) {
      throw ApiException.invalidRequest("API key is too short");
    }
    ObjectNode payload = mapper.createObjectNode().put("apiKey", trimmed);
    baseUrl.map(String::trim).filter(value -> !value.isBlank()).ifPresent(value -> payload.put("baseUrl", value));
    try {
      byte[] iv = new byte[IV_BYTES];
      random.nextBytes(iv);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
      byte[] encrypted = cipher.doFinal(mapper.writeValueAsBytes(payload));
      byte[] tag = java.util.Arrays.copyOfRange(encrypted, encrypted.length - 16, encrypted.length);
      byte[] body = java.util.Arrays.copyOf(encrypted, encrypted.length - 16);
      return String.join(".", VERSION, b64(iv), b64(tag), b64(body));
    } catch (Exception error) {
      throw new ApiException("credential_encrypt_failed", "Failed to encrypt credential", 500);
    }
  }

  public Secret decrypt(String ciphertext) {
    String[] parts = Optional.ofNullable(ciphertext).orElse("").split("\\.");
    if (parts.length != 4 || !VERSION.equals(parts[0])) {
      throw new ApiException("credential_ciphertext_invalid", "Stored credential ciphertext is invalid", 500);
    }
    try {
      byte[] iv = Base64.getUrlDecoder().decode(parts[1]);
      byte[] tag = Base64.getUrlDecoder().decode(parts[2]);
      byte[] body = Base64.getUrlDecoder().decode(parts[3]);
      ByteBuffer combined = ByteBuffer.allocate(body.length + tag.length);
      combined.put(body).put(tag);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
      var node = mapper.readTree(cipher.doFinal(combined.array()));
      String apiKey = node.path("apiKey").asText("");
      if (apiKey.trim().length() < 8) {
        throw new ApiException("credential_ciphertext_invalid", "Stored credential ciphertext is invalid", 500);
      }
      Optional<String> baseUrl = Optional.ofNullable(node.path("baseUrl").asText(null))
          .filter(value -> !value.isBlank());
      return new Secret(apiKey, baseUrl);
    } catch (ApiException error) {
      throw error;
    } catch (Exception error) {
      throw new ApiException("credential_ciphertext_invalid", "Stored credential ciphertext is invalid", 500);
    }
  }

  public java.util.Map<String, String> modelEnvironment(String provider, String model, Secret secret) {
    ProviderEnv mapping = ProviderEnv.of(provider);
    java.util.LinkedHashMap<String, String> env = new java.util.LinkedHashMap<>();
    env.put("AGENT_LLM_PROVIDER", provider);
    env.put("AGENT_LLM_MODEL", model);
    env.put(mapping.apiKey, secret.apiKey());
    env.put(mapping.model, model);
    secret.baseUrl().ifPresent(url -> env.put(mapping.baseUrl, url));
    return env;
  }

  private static String b64(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  public record Secret(String apiKey, Optional<String> baseUrl) {}

  private record ProviderEnv(String apiKey, String model, String baseUrl) {
    static ProviderEnv of(String provider) {
      return switch (provider) {
        case "openai" -> new ProviderEnv("OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL");
        case "anthropic" -> new ProviderEnv("ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL");
        case "openrouter" -> new ProviderEnv("OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_BASE_URL");
        case "deepseek" -> new ProviderEnv("DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL");
        case "xai" -> new ProviderEnv("XAI_API_KEY", "XAI_MODEL", "XAI_BASE_URL");
        default -> throw new ApiException("unsupported_model_provider", "Unsupported model provider: " + provider, 400);
      };
    }
  }
}
