package com.kross.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kross.api.ApiException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.RemoteJWKSet;
import com.nimbusds.jose.proc.JWSAlgorithmFamilyJWSKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;

@Component
public class OidcClient {
  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper;

  public OidcClient(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  public Discovery discover(String issuer) {
    String normalized = normalizeIssuer(issuer);
    JsonNode document = getJson(normalized + "/.well-known/openid-configuration");
    String discoveredIssuer = Optional.ofNullable(document.path("issuer").asText(null)).map(OidcClient::normalizeIssuer)
        .orElse("");
    if (!normalized.equals(discoveredIssuer)) {
      throw new ApiException("sso_discovery_failed", "OIDC issuer does not match discovery document", 400);
    }
    String authorization = requiredText(document, "authorization_endpoint");
    String token = requiredText(document, "token_endpoint");
    String jwks = requiredText(document, "jwks_uri");
    return new Discovery(normalized, authorization, token, jwks);
  }

  public String authorizationUrl(Discovery discovery, String clientId, String redirectUri, String state, String nonce,
      String codeChallenge) {
    Map<String, String> query = new LinkedHashMap<>();
    query.put("client_id", clientId);
    query.put("redirect_uri", redirectUri);
    query.put("response_type", "code");
    query.put("scope", "openid profile email");
    query.put("state", state);
    query.put("nonce", nonce);
    query.put("code_challenge", codeChallenge);
    query.put("code_challenge_method", "S256");
    String encoded = query.entrySet().stream()
        .map(entry -> entry.getKey() + "=" + URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8))
        .collect(Collectors.joining("&"));
    return discovery.authorizationEndpoint() + (discovery.authorizationEndpoint().contains("?") ? "&" : "?") + encoded;
  }

  public JWTClaimsSet exchange(Discovery discovery, String clientId, String clientSecret, String redirectUri,
      String code, String codeVerifier, String nonce) {
    Map<String, String> form = new LinkedHashMap<>();
    form.put("grant_type", "authorization_code");
    form.put("code", code);
    form.put("redirect_uri", redirectUri);
    form.put("client_id", clientId);
    form.put("client_secret", clientSecret);
    form.put("code_verifier", codeVerifier);
    String body = form.entrySet().stream()
        .map(entry -> entry.getKey() + "=" + URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8))
        .collect(Collectors.joining("&"));
    JsonNode token = postForm(discovery.tokenEndpoint(), body);
    if (token.hasNonNull("error")) {
      throw new ApiException("sso_token_failed", "Identity provider rejected the authorization code", 401);
    }
    String idToken = Optional.ofNullable(token.path("id_token").asText(null)).filter(value -> !value.isBlank())
        .orElseThrow(() -> new ApiException("sso_token_failed", "Identity provider did not return an ID token", 401));
    return verifyIdToken(discovery, clientId, idToken, nonce);
  }

  private JWTClaimsSet verifyIdToken(Discovery discovery, String clientId, String idToken, String nonce) {
    try {
      ConfigurableJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
      processor.setJWSKeySelector(new JWSAlgorithmFamilyJWSKeySelector<>(
          JWSAlgorithm.Family.RSA,
          new RemoteJWKSet<>(URI.create(discovery.jwksUri()).toURL())));
      processor.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(
          new JWTClaimsSet.Builder().issuer(discovery.issuer()).audience(clientId).build(),
          Set.of("sub", "exp")));
      JWTClaimsSet claims = processor.process(idToken, null);
      String tokenNonce = Optional.ofNullable(claims.getStringClaim("nonce")).orElse("");
      if (!nonce.equals(tokenNonce)) {
        throw new ApiException("sso_token_failed", "SSO nonce mismatch", 401);
      }
      return claims;
    } catch (ApiException error) {
      throw error;
    } catch (Exception error) {
      throw new ApiException("sso_token_failed", "Failed to verify SSO identity token", 401);
    }
  }

  private JsonNode getJson(String url) {
    try {
      HttpResponse<String> response = http.send(
          HttpRequest.newBuilder(URI.create(url))
              .timeout(Duration.ofSeconds(10))
              .header("accept", "application/json")
              .GET()
              .build(),
          HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() < 200 || response.statusCode() >= 300) {
        throw new ApiException("sso_discovery_failed", "Failed to load OIDC discovery document", 400);
      }
      return mapper.readTree(response.body());
    } catch (ApiException error) {
      throw error;
    } catch (Exception error) {
      throw new ApiException("sso_discovery_failed", "Failed to load OIDC discovery document", 400);
    }
  }

  private JsonNode postForm(String url, String body) {
    try {
      HttpResponse<String> response = http.send(
          HttpRequest.newBuilder(URI.create(url))
              .timeout(Duration.ofSeconds(15))
              .header("accept", "application/json")
              .header("content-type", "application/x-www-form-urlencoded")
              .POST(HttpRequest.BodyPublishers.ofString(body))
              .build(),
          HttpResponse.BodyHandlers.ofString());
      return mapper.readTree(response.body());
    } catch (Exception error) {
      throw new ApiException("sso_token_failed", "Failed to exchange SSO authorization code", 401);
    }
  }

  private static String requiredText(JsonNode document, String field) {
    return Optional.ofNullable(document.path(field).asText(null)).filter(value -> !value.isBlank())
        .orElseThrow(() -> new ApiException("sso_discovery_failed", "OIDC discovery document is missing " + field, 400));
  }

  public static String normalizeIssuer(String issuer) {
    String value = Optional.ofNullable(issuer).map(String::trim).orElse("");
    if (value.endsWith("/")) {
      value = value.substring(0, value.length() - 1);
    }
    if (!value.startsWith("https://") && !value.startsWith("http://")) {
      throw ApiException.invalidRequest("Issuer must be an http(s) URL");
    }
    return value;
  }

  public record Discovery(String issuer, String authorizationEndpoint, String tokenEndpoint, String jwksUri) {}
}
