import { createHash } from 'node:crypto';

import Docker from 'dockerode';

import { OrchestratorError } from './errors';
import type {
  BackendHandle,
  BackendInspection,
  ContainerBackend,
  ManagedExecution,
  RunLaunchRequest
} from './types';

const LABEL_PREFIX = 'dev.kross.run';
const RUN_LABEL = `${LABEL_PREFIX}.id`;
const GENERATION_LABEL = `${LABEL_PREFIX}.generation`;
const DEADLINE_LABEL = `${LABEL_PREFIX}.deadline`;
const MANAGER_LABEL = `${LABEL_PREFIX}.manager`;
const VOLUME_LABEL = `${LABEL_PREFIX}.volume`;
const NETWORK_LABEL = `${LABEL_PREFIX}.network`;

export interface DockerBackendOptions {
  image?: string;
  managerId?: string;
  /** Numeric uid:gid baked into the Worker image. Root is deliberately rejected. */
  workerUser?: string;
  /** Container name/id for the only control-plane / Connector Proxy peer. */
  controlPlaneContainer?: string;
  stopTimeoutSeconds?: number;
}

export class DockerBackend implements ContainerBackend {
  private readonly image: string;
  private readonly managerId: string;
  private readonly workerUser: string;
  private readonly controlPlaneContainer?: string;
  private readonly stopTimeoutSeconds: number;

  constructor(
    private readonly docker: Docker = new Docker(),
    options: DockerBackendOptions = {}
  ) {
    this.image = options.image ?? 'kross-worker:local';
    this.managerId = options.managerId ?? 'kross-orchestrator';
    this.workerUser = options.workerUser ?? '1000:1000';
    this.controlPlaneContainer = options.controlPlaneContainer;
    this.stopTimeoutSeconds = options.stopTimeoutSeconds ?? 15;
    if (/^0(?::0)?$/.test(this.workerUser)) {
      throw new OrchestratorError(
        'INVALID_WORKER_USER',
        'Worker 必须以非 root 用户运行',
        500
      );
    }
  }

  async launch(request: RunLaunchRequest): Promise<BackendHandle> {
    assertSafeLaunchRequest(request);
    if (!this.controlPlaneContainer) {
      throw new OrchestratorError(
        'CONTROL_PLANE_PEER_REQUIRED',
        'Worker 必须配置受限控制面/Connector Proxy 容器以完成注册和心跳',
        500
      );
    }

    const names = resourceNames(request.runId, request.generation);
    const deadlineAt = new Date(
      Date.now() + request.resourceLimits.maxDurationMs
    ).toISOString();
    const labels = {
      [RUN_LABEL]: request.runId,
      [GENERATION_LABEL]: String(request.generation),
      [DEADLINE_LABEL]: deadlineAt,
      [MANAGER_LABEL]: this.managerId
    };
    let volumeCreated = false;
    let networkCreated = false;
    let container: Docker.Container | undefined;

    try {
      await this.docker.createVolume({
        Name: names.volumeName,
        Labels: { ...labels, [VOLUME_LABEL]: 'true' },
        Driver: 'local',
        DriverOpts: {
          type: 'tmpfs',
          device: 'tmpfs',
          o: `size=${request.resourceLimits.diskBytes},uid=1000,gid=1000,mode=0700`
        }
      });
      volumeCreated = true;

      await this.docker.createNetwork({
        Name: names.networkName,
        Driver: 'bridge',
        Internal: true,
        CheckDuplicate: true,
        Labels: { ...labels, [NETWORK_LABEL]: 'true' }
      });
      networkCreated = true;
      await this.docker.getNetwork(names.networkName).connect({
        Container: this.controlPlaneContainer!
      });

      container = await this.docker.createContainer({
        name: names.containerName,
        Image: this.image,
        User: this.workerUser,
        Env: [
          `KROSS_RUN_ID=${request.runId}`,
          `KROSS_GENERATION=${request.generation}`,
          `KROSS_LEASE_ID=${request.leaseId}`,
          `KROSS_RUN_TOKEN=${request.runToken}`,
          `KROSS_RUN_SPEC_URL=${request.runSpecUrl}`,
          `KROSS_RUN_TOKEN_EXPIRES_AT=${request.tokenExpiresAt}`,
          'KROSS_PHYSICAL_WORK_ROOT=/work'
        ],
        Labels: labels,
        WorkingDir: '/work',
        StopTimeout: this.stopTimeoutSeconds,
        HostConfig: {
          Binds: [`${names.volumeName}:/work:rw`],
          NetworkMode: names.networkName,
          Memory: request.resourceLimits.memoryBytes,
          MemorySwap: request.resourceLimits.memoryBytes,
          NanoCpus: request.resourceLimits.cpuMillis * 1_000_000,
          PidsLimit: request.resourceLimits.maxPids,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          OomKillDisable: false,
          Init: true,
          AutoRemove: false,
          RestartPolicy: { Name: 'no' },
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000,mode=0700',
            '/run': 'rw,noexec,nosuid,nodev,size=16777216,uid=1000,gid=1000,mode=0700'
          }
        }
      });
      await container.start();
      return {
        runId: request.runId,
        generation: request.generation,
        containerId: container.id,
        containerName: names.containerName,
        volumeName: names.volumeName,
        networkName: names.networkName,
        deadlineAt
      };
    } catch (error) {
      if (container) {
        await container.remove({ force: true }).catch(() => undefined);
      }
      if (networkCreated) await this.removeNetwork(names.networkName);
      if (volumeCreated) {
        await this.docker
          .getVolume(names.volumeName)
          .remove()
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async inspect(handle: BackendHandle): Promise<BackendInspection> {
    try {
      const state = await this.docker.getContainer(handle.containerId).inspect();
      return {
        ...handle,
        state: state.State.Running
          ? 'running'
          : state.State.Status === 'created'
            ? 'created'
            : 'exited',
        startedAt: normalizeDockerTimestamp(state.State.StartedAt),
        finishedAt: normalizeDockerTimestamp(state.State.FinishedAt),
        exitCode: state.State.Running ? undefined : state.State.ExitCode
      };
    } catch (error) {
      if (isDockerNotFound(error)) return { ...handle, state: 'missing' };
      throw error;
    }
  }

  async terminate(handle: BackendHandle): Promise<void> {
    const container = this.docker.getContainer(handle.containerId);
    const state = await container.inspect().catch((error: unknown) => {
      if (isDockerNotFound(error)) return undefined;
      throw error;
    });
    if (state?.State.Running) {
      await container.stop({ t: this.stopTimeoutSeconds });
    }
  }

  async remove(handle: BackendHandle): Promise<void> {
    const container = this.docker.getContainer(handle.containerId);
    await container.stop({ t: this.stopTimeoutSeconds }).catch(() => undefined);
    await container.remove({ force: true }).catch((error: unknown) => {
      if (!isDockerNotFound(error)) throw error;
    });
    if (handle.networkName) await this.removeNetwork(handle.networkName);
    await this.docker
      .getVolume(handle.volumeName)
      .remove()
      .catch((error: unknown) => {
        if (!isDockerNotFound(error)) throw error;
      });
  }

  async listManaged(): Promise<ManagedExecution[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGER_LABEL}=${this.managerId}`, RUN_LABEL] }
    });
    return Promise.all(
      containers.flatMap((summary) => {
        const runId = summary.Labels?.[RUN_LABEL];
        const generation = Number(summary.Labels?.[GENERATION_LABEL]);
        const deadlineAt = summary.Labels?.[DEADLINE_LABEL];
        if (!runId || !Number.isSafeInteger(generation) || !deadlineAt) return [];
        const names = resourceNames(runId, generation);
        const handle: BackendHandle = {
          runId,
          generation,
          containerId: summary.Id,
          containerName: summary.Names?.[0]?.replace(/^\//, '') ?? names.containerName,
          volumeName: names.volumeName,
          networkName: names.networkName,
          deadlineAt
        };
        return [this.inspect(handle)];
      })
    );
  }

  async reapInfrastructureOrphans(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGER_LABEL}=${this.managerId}`] }
    });
    const liveRunKeys = new Set(
      containers.map(
        (container) =>
          `${container.Labels?.[RUN_LABEL]}:${container.Labels?.[GENERATION_LABEL]}`
      )
    );
    let removed = 0;
    const volumes = await this.docker.listVolumes({
      filters: { label: [`${MANAGER_LABEL}=${this.managerId}`, VOLUME_LABEL] }
    });
    for (const volume of volumes.Volumes ?? []) {
      if (liveRunKeys.has(resourceKeyFromLabels(volume.Labels))) continue;
      await this.docker.getVolume(volume.Name).remove().catch(() => undefined);
      removed += 1;
    }
    const networks = await this.docker.listNetworks({
      filters: { label: [`${MANAGER_LABEL}=${this.managerId}`, NETWORK_LABEL] }
    });
    for (const network of networks) {
      if (liveRunKeys.has(resourceKeyFromLabels(network.Labels))) continue;
      await this.removeNetwork(network.Name);
      removed += 1;
    }
    return removed;
  }

  async health(): Promise<boolean> {
    return this.docker
      .ping()
      .then(() => true)
      .catch(() => false);
  }

  private async removeNetwork(name: string): Promise<void> {
    const network = this.docker.getNetwork(name);
    if (this.controlPlaneContainer) {
      await network
        .disconnect({ Container: this.controlPlaneContainer, Force: true })
        .catch(() => undefined);
    }
    await network.remove().catch((error: unknown) => {
      if (!isDockerNotFound(error)) throw error;
    });
  }
}

function resourceNames(runId: string, generation: number) {
  const digest = createHash('sha256')
    .update(`${runId}:${generation}`)
    .digest('hex')
    .slice(0, 16);
  return {
    containerName: `kross-run-${digest}`,
    volumeName: `kross-run-volume-${digest}`,
    networkName: `kross-run-net-${digest}`
  };
}

function assertSafeLaunchRequest(request: RunLaunchRequest): void {
  const expiresAt = Date.parse(request.tokenExpiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 30 * 60_000) {
    throw new OrchestratorError(
      'INVALID_RUN_TOKEN_EXPIRY',
      'Run Token 必须在未来 30 分钟内过期',
      400
    );
  }
  const url = new URL(request.runSpecUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new OrchestratorError('INVALID_RUN_SPEC_URL', 'RunSpec URL 协议无效', 400);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OrchestratorError(
      'RUN_SPEC_URL_CONTAINS_CREDENTIAL',
      'RunSpec URL 不得内嵌凭证、查询参数或片段',
      400
    );
  }
}

function normalizeDockerTimestamp(value?: string): string | undefined {
  if (!value || value.startsWith('0001-')) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function resourceKeyFromLabels(labels?: Record<string, string>): string {
  return `${labels?.[RUN_LABEL]}:${labels?.[GENERATION_LABEL]}`;
}

function isDockerNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}
