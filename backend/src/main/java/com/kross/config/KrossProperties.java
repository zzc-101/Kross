package com.kross.config;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Optional;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "kross")
public class KrossProperties {
  private String devIdentityEnabled = "false";
  private String publicBaseUrl = "http://127.0.0.1:8787";
  private String externalBaseUrl = "http://127.0.0.1:8787";
  private String credentialMasterKey = "";
  private String schedulerOwner = "kross-server";
  private String workerImage = "kross-worker:local";
  private String orchestratorManagerId = "kross-saas";
  private String controlPlaneContainer = "";
  private String objectStoreContainer = "";
  private String agentNetwork = "";
  private String workerRuntime = "local";
  private String workerStorage = "local";
  private String juicefsMount = "";
  private final Api api = new Api();
  private final Scheduler scheduler = new Scheduler();
  private final Agent agent = new Agent();
  private final S3 s3 = new S3();
  private final Kubernetes kubernetes = new Kubernetes();

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

  public String getExternalBaseUrl() {
    return externalBaseUrl;
  }

  public void setExternalBaseUrl(String externalBaseUrl) {
    this.externalBaseUrl = externalBaseUrl;
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

  public Optional<String> getAgentNetwork() {
    return Optional.ofNullable(agentNetwork).filter(value -> !value.isBlank());
  }

  public void setAgentNetwork(String agentNetwork) {
    this.agentNetwork = agentNetwork;
  }

  public String getWorkerStorage() {
    return workerStorage;
  }

  public void setWorkerStorage(String workerStorage) {
    this.workerStorage = Optional.ofNullable(workerStorage).filter(value -> !value.isBlank()).orElse("local");
  }

  public String getJuicefsMount() {
    return juicefsMount;
  }

  public void setJuicefsMount(String juicefsMount) {
    this.juicefsMount = Optional.ofNullable(juicefsMount).orElse("");
  }

  public String getWorkerRuntime() {
    return workerRuntime;
  }

  public void setWorkerRuntime(String workerRuntime) {
    this.workerRuntime = Optional.ofNullable(workerRuntime).filter(value -> !value.isBlank()).orElse("local");
  }

  public boolean isKubernetesRuntime() {
    return "kubernetes".equalsIgnoreCase(workerRuntime);
  }

  public Api getApi() {
    return api;
  }

  public Scheduler getScheduler() {
    return scheduler;
  }

  public Agent getAgent() {
    return agent;
  }

  public S3 getS3() {
    return s3;
  }

  public Kubernetes getKubernetes() {
    return kubernetes;
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

  public static class Agent {
    private long idleMs = 900_000;
    private long tokenTtlMs = 12 * 60 * 60 * 1_000L;
    private long heartbeatIntervalMs = 10_000;
    private long jobLeaseMs = 90_000;
    private int jobMaxAttempts = 2;
    private long startTimeoutMs = 120_000;
    private int cpuMillis = 2_000;
    private long memoryBytes = 1_073_741_824L;
    private int maxPids = 512;

    public long getIdleMs() {
      return idleMs;
    }

    public void setIdleMs(long idleMs) {
      this.idleMs = idleMs;
    }

    public long getTokenTtlMs() {
      return tokenTtlMs;
    }

    public void setTokenTtlMs(long tokenTtlMs) {
      this.tokenTtlMs = tokenTtlMs;
    }

    public long getHeartbeatIntervalMs() {
      return heartbeatIntervalMs;
    }

    public void setHeartbeatIntervalMs(long heartbeatIntervalMs) {
      this.heartbeatIntervalMs = heartbeatIntervalMs;
    }

    public long getJobLeaseMs() {
      return jobLeaseMs;
    }

    public void setJobLeaseMs(long jobLeaseMs) {
      this.jobLeaseMs = Math.max(jobLeaseMs, 30_000);
    }

    public int getJobMaxAttempts() {
      return jobMaxAttempts;
    }

    public void setJobMaxAttempts(int jobMaxAttempts) {
      this.jobMaxAttempts = Math.max(jobMaxAttempts, 1);
    }

    public long getStartTimeoutMs() {
      return startTimeoutMs;
    }

    public void setStartTimeoutMs(long startTimeoutMs) {
      this.startTimeoutMs = Math.max(startTimeoutMs, 1_000);
    }

    public int getCpuMillis() {
      return cpuMillis;
    }

    public void setCpuMillis(int cpuMillis) {
      this.cpuMillis = cpuMillis;
    }

    public long getMemoryBytes() {
      return memoryBytes;
    }

    public void setMemoryBytes(long memoryBytes) {
      this.memoryBytes = memoryBytes;
    }

    public int getMaxPids() {
      return maxPids;
    }

    public void setMaxPids(int maxPids) {
      this.maxPids = maxPids;
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

  public static class Kubernetes {
    private static final Path SERVICE_ACCOUNT_NAMESPACE =
        Path.of("/var/run/secrets/kubernetes.io/serviceaccount/namespace");

    private String namespace = "";
    private String storageClass = "kross-juicefs";
    private String workspaceSize = "10Gi";

    public String getNamespace() {
      return namespace;
    }

    public void setNamespace(String namespace) {
      this.namespace = Optional.ofNullable(namespace).orElse("");
    }

    public String getStorageClass() {
      return storageClass;
    }

    public void setStorageClass(String storageClass) {
      this.storageClass = Optional.ofNullable(storageClass).filter(value -> !value.isBlank()).orElse("kross-juicefs");
    }

    public String getWorkspaceSize() {
      return workspaceSize;
    }

    public void setWorkspaceSize(String workspaceSize) {
      this.workspaceSize = Optional.ofNullable(workspaceSize).filter(value -> !value.isBlank()).orElse("10Gi");
    }

    public Optional<String> resolveNamespace() {
      Optional<String> configured = Optional.ofNullable(namespace).map(String::trim).filter(value -> !value.isBlank());
      if (configured.isPresent()) {
        return configured;
      }
      if (!Files.isRegularFile(SERVICE_ACCOUNT_NAMESPACE)) {
        return Optional.empty();
      }
      try {
        return Optional.of(Files.readString(SERVICE_ACCOUNT_NAMESPACE).trim()).filter(value -> !value.isBlank());
      } catch (Exception error) {
        return Optional.empty();
      }
    }

    public String requireNamespace() {
      return resolveNamespace().orElseThrow(() -> new IllegalStateException(
          "KROSS_WORKER_RUNTIME=kubernetes requires KROSS_KUBERNETES_NAMESPACE or an in-cluster ServiceAccount namespace"));
    }
  }
}
