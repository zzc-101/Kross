package com.kross.config;

import java.time.Duration;
import java.util.Optional;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "kross")
public class KrossProperties {
  private String devIdentityEnabled = "false";
  private String publicBaseUrl = "http://127.0.0.1:8787";
  private String credentialMasterKey = "";
  private String schedulerOwner = "kross-server";
  private String workerImage = "kross-worker:local";
  private String orchestratorManagerId = "kross-saas";
  private String controlPlaneContainer = "";
  private String objectStoreContainer = "";
  private final Api api = new Api();
  private final Scheduler scheduler = new Scheduler();
  private final S3 s3 = new S3();

  public boolean isDevIdentityEnabled() {
    return "1".equals(devIdentityEnabled) || Boolean.parseBoolean(devIdentityEnabled);
  }

  public String getDevIdentityEnabled() {
    return devIdentityEnabled;
  }

  public void setDevIdentityEnabled(String devIdentityEnabled) {
    this.devIdentityEnabled = Optional.ofNullable(devIdentityEnabled).orElse("false");
  }

  public String getPublicBaseUrl() {
    return publicBaseUrl;
  }

  public void setPublicBaseUrl(String publicBaseUrl) {
    this.publicBaseUrl = publicBaseUrl;
  }

  public String getCredentialMasterKey() {
    return credentialMasterKey;
  }

  public void setCredentialMasterKey(String credentialMasterKey) {
    this.credentialMasterKey = credentialMasterKey;
  }

  public String getSchedulerOwner() {
    return schedulerOwner;
  }

  public void setSchedulerOwner(String schedulerOwner) {
    this.schedulerOwner = schedulerOwner;
  }

  public String getWorkerImage() {
    return workerImage;
  }

  public void setWorkerImage(String workerImage) {
    this.workerImage = workerImage;
  }

  public String getOrchestratorManagerId() {
    return orchestratorManagerId;
  }

  public void setOrchestratorManagerId(String orchestratorManagerId) {
    this.orchestratorManagerId = orchestratorManagerId;
  }

  public Optional<String> getControlPlaneContainer() {
    return Optional.ofNullable(controlPlaneContainer).filter(value -> !value.isBlank());
  }

  public void setControlPlaneContainer(String controlPlaneContainer) {
    this.controlPlaneContainer = controlPlaneContainer;
  }

  public Optional<String> getObjectStoreContainer() {
    return Optional.ofNullable(objectStoreContainer).filter(value -> !value.isBlank());
  }

  public void setObjectStoreContainer(String objectStoreContainer) {
    this.objectStoreContainer = objectStoreContainer;
  }

  public Api getApi() {
    return api;
  }

  public Scheduler getScheduler() {
    return scheduler;
  }

  public S3 getS3() {
    return s3;
  }

  public static class Api {
    private String prefix = "/api/v2";

    public String getPrefix() {
      return prefix;
    }

    public void setPrefix(String prefix) {
      String value = Optional.ofNullable(prefix).orElse("/api/v2").trim();
      if (!value.startsWith("/")) {
        value = "/" + value;
      }
      if (value.length() > 1 && value.endsWith("/")) {
        value = value.substring(0, value.length() - 1);
      }
      this.prefix = value;
    }
  }

  public static class Scheduler {
    private long pollMs = 1_000;
    private long leaseDurationMs = 30_000;
    private long tokenTtlMs = 30_000;
    private long retryDelayMs = 5_000;
    private long heartbeatIntervalMs = 10_000;

    public long getPollMs() {
      return pollMs;
    }

    public void setPollMs(long pollMs) {
      this.pollMs = pollMs;
    }

    public long getLeaseDurationMs() {
      return leaseDurationMs;
    }

    public void setLeaseDurationMs(long leaseDurationMs) {
      this.leaseDurationMs = leaseDurationMs;
    }

    public long getTokenTtlMs() {
      return tokenTtlMs;
    }

    public void setTokenTtlMs(long tokenTtlMs) {
      this.tokenTtlMs = tokenTtlMs;
    }

    public long getRetryDelayMs() {
      return retryDelayMs;
    }

    public void setRetryDelayMs(long retryDelayMs) {
      this.retryDelayMs = retryDelayMs;
    }

    public long getHeartbeatIntervalMs() {
      return heartbeatIntervalMs;
    }

    public void setHeartbeatIntervalMs(long heartbeatIntervalMs) {
      this.heartbeatIntervalMs = heartbeatIntervalMs;
    }
  }

  public static class S3 {
    private String endpoint = "http://127.0.0.1:9000";
    private String publicEndpoint = "http://127.0.0.1:9000";
    private String region = "us-east-1";
    private String bucket = "kross";
    private String accessKey = "kross";
    private String secretKey = "kross-minio-secret";
    private boolean pathStyle = true;
    private Duration presignTtl = Duration.ofMinutes(15);

    public String getEndpoint() {
      return endpoint;
    }

    public void setEndpoint(String endpoint) {
      this.endpoint = endpoint;
    }

    public String getPublicEndpoint() {
      return publicEndpoint;
    }

    public void setPublicEndpoint(String publicEndpoint) {
      this.publicEndpoint = publicEndpoint;
    }

    public String getRegion() {
      return region;
    }

    public void setRegion(String region) {
      this.region = region;
    }

    public String getBucket() {
      return bucket;
    }

    public void setBucket(String bucket) {
      this.bucket = bucket;
    }

    public String getAccessKey() {
      return accessKey;
    }

    public void setAccessKey(String accessKey) {
      this.accessKey = accessKey;
    }

    public String getSecretKey() {
      return secretKey;
    }

    public void setSecretKey(String secretKey) {
      this.secretKey = secretKey;
    }

    public boolean isPathStyle() {
      return pathStyle;
    }

    public void setPathStyle(boolean pathStyle) {
      this.pathStyle = pathStyle;
    }

    public Duration getPresignTtl() {
      return presignTtl;
    }

    public void setPresignTtl(Duration presignTtl) {
      this.presignTtl = presignTtl;
    }
  }
}
