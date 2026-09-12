package com.kross.storage;

import com.kross.api.ApiException;
import com.kross.config.AppProperties;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CORSRule;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectResponse;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutBucketCorsRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.model.CopyObjectRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;

@Component
public class ObjectStorage {
  public enum Audience { INTERNAL, PUBLIC }

  private final AppProperties.S3 properties;
  private final S3Client client;
  private final S3Presigner internalPresigner;
  private final S3Presigner publicPresigner;

  public ObjectStorage(AppProperties properties) {
    this.properties = properties.getS3();
    AwsBasicCredentials credentials =
        AwsBasicCredentials.create(this.properties.getAccessKey(), this.properties.getSecretKey());
    S3Configuration s3Config = S3Configuration.builder()
        .pathStyleAccessEnabled(this.properties.isPathStyle())
        .build();
    this.client = S3Client.builder()
        .endpointOverride(URI.create(this.properties.getEndpoint()))
        .region(Region.of(this.properties.getRegion()))
        .credentialsProvider(StaticCredentialsProvider.create(credentials))
        .serviceConfiguration(s3Config)
        .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
        .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
        .build();
    this.internalPresigner = presigner(this.properties.getEndpoint(), credentials, s3Config);
    this.publicPresigner = presigner(this.properties.getPublicEndpoint(), credentials, s3Config);
  }

  public void ensureBucket() {
    try {
      client.headBucket(builder -> builder.bucket(properties.getBucket()));
    } catch (software.amazon.awssdk.services.s3.model.S3Exception error) {
      client.createBucket(CreateBucketRequest.builder().bucket(properties.getBucket()).build());
    }
    try {
      client.putBucketCors(PutBucketCorsRequest.builder()
          .bucket(properties.getBucket())
          .corsConfiguration(cors -> cors.corsRules(CORSRule.builder()
              .allowedHeaders("*")
              .allowedMethods("GET", "PUT", "HEAD")
              .allowedOrigins("*")
              .exposeHeaders("ETag", "x-amz-checksum-sha256")
              .maxAgeSeconds(3600)
              .build()))
          .build());
    } catch (S3Exception error) {
      // MinIO Community Edition uses cluster-wide CORS and returns 501 for PutBucketCors.
      if (error.statusCode() != 501) {
        throw error;
      }
    }
  }

  public SignedUrl presignPut(String key, Audience audience, String mimeType, Instant expiresAt) {
    PutObjectRequest put = PutObjectRequest.builder()
        .bucket(properties.getBucket())
        .key(key)
        .contentType(mimeType)
        .build();
    String url = presigner(audience).presignPutObject(PutObjectPresignRequest.builder()
        .signatureDuration(ttl(expiresAt))
        .putObjectRequest(put)
        .build()).url().toString();
    return new SignedUrl("PUT", url, expiresAt);
  }

  public SignedUrl presignGet(String key, Audience audience, Instant expiresAt) {
    return presignGet(key, audience, expiresAt, null, null);
  }

  public SignedUrl presignGet(
      String key, Audience audience, Instant expiresAt, String contentType, String contentDisposition) {
    GetObjectRequest.Builder get = GetObjectRequest.builder().bucket(properties.getBucket()).key(key);
    Optional.ofNullable(contentType).map(String::trim).filter(value -> !value.isBlank())
        .ifPresent(get::responseContentType);
    Optional.ofNullable(contentDisposition).map(String::trim).filter(value -> !value.isBlank())
        .ifPresent(get::responseContentDisposition);
    String url = presigner(audience).presignGetObject(GetObjectPresignRequest.builder()
        .signatureDuration(ttl(expiresAt))
        .getObjectRequest(get.build())
        .build()).url().toString();
    return new SignedUrl("GET", url, expiresAt);
  }

  public void putBytes(String key, byte[] bytes, String mimeType) {
    client.putObject(
        PutObjectRequest.builder().bucket(properties.getBucket()).key(key).contentType(mimeType).build(),
        RequestBody.fromBytes(bytes));
  }

  public void putStream(String key, java.io.InputStream stream, long size, String mimeType) {
    client.putObject(
        PutObjectRequest.builder()
            .bucket(properties.getBucket())
            .key(key)
            .contentType(mimeType)
            .contentLength(size)
            .build(),
        RequestBody.fromInputStream(stream, size));
  }

  public Optional<ObjectStat> head(String key) {
    try {
      HeadObjectResponse response = client.headObject(
          HeadObjectRequest.builder().bucket(properties.getBucket()).key(key).build());
      return Optional.of(new ObjectStat(key, response.contentLength(), response.eTag()));
    } catch (NoSuchKeyException error) {
      return Optional.empty();
    } catch (software.amazon.awssdk.services.s3.model.S3Exception error) {
      if (error.statusCode() == 404) {
        return Optional.empty();
      }
      throw error;
    }
  }

  public String promote(String stagingKey, String sha256, long expectedSizeBytes) {
    ObjectStat staging = head(stagingKey)
        .orElseThrow(() -> new ApiException("blob_not_found", "Uploaded blob not found", 404));
    if (staging.sizeBytes() != expectedSizeBytes) {
      throw new ApiException("blob_size_mismatch", "Artifact size does not match", 422);
    }
    String key = contentAddressedKey(sha256);
    if (head(key).isEmpty()) {
      copy(stagingKey, key);
    }
    delete(stagingKey);
    return key;
  }

  public void copy(String fromKey, String toKey) {
    client.copyObject(CopyObjectRequest.builder()
        .sourceBucket(properties.getBucket())
        .sourceKey(fromKey)
        .destinationBucket(properties.getBucket())
        .destinationKey(toKey)
        .build());
  }

  public void delete(String key) {
    client.deleteObject(DeleteObjectRequest.builder().bucket(properties.getBucket()).key(key).build());
  }

  public software.amazon.awssdk.core.ResponseInputStream<software.amazon.awssdk.services.s3.model.GetObjectResponse> get(
      String key) {
    try {
      return client.getObject(GetObjectRequest.builder().bucket(properties.getBucket()).key(key).build());
    } catch (NoSuchKeyException error) {
      throw ApiException.notFound("Blob");
    }
  }

  public static String contentAddressedKey(String sha256) {
    return "sha256/" + sha256.substring(0, 2) + "/" + sha256;
  }

  private S3Presigner presigner(Audience audience) {
    return audience == Audience.PUBLIC ? publicPresigner : internalPresigner;
  }

  private S3Presigner presigner(String endpoint, AwsBasicCredentials credentials, S3Configuration s3Config) {
    return S3Presigner.builder()
        .endpointOverride(URI.create(endpoint))
        .region(Region.of(properties.getRegion()))
        .credentialsProvider(StaticCredentialsProvider.create(credentials))
        .serviceConfiguration(s3Config)
        .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
        .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
        .build();
  }

  private Duration ttl(Instant expiresAt) {
    Duration duration = Duration.between(Instant.now(), expiresAt);
    if (duration.isNegative() || duration.isZero()) {
      throw ApiException.invalidRequest("Signed URL expiry must be in the future");
    }
    return duration;
  }

  public record SignedUrl(String method, String url, Instant expiresAt) {}

  public record ObjectStat(String key, long sizeBytes, String etag) {}
}
