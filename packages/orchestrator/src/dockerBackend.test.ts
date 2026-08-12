import Docker from 'dockerode';
import { describe, expect, it } from 'vitest';

import { DockerBackend } from './dockerBackend';
import type { RunLaunchRequest } from './types';

class FakeDocker {
  readonly volumeConfigs: Array<Record<string, unknown>> = [];
  readonly networkConfigs: Array<Record<string, unknown>> = [];
  readonly containerConfigs: Array<Record<string, unknown>> = [];
  readonly removedVolumes: string[] = [];
  readonly removedNetworks: string[] = [];
  readonly removedContainers: string[] = [];
  readonly connectedPeers: string[] = [];
  failStart = false;

  async createVolume(config: Record<string, unknown>) {
    this.volumeConfigs.push(config);
    return {};
  }

  getVolume(name: string) {
    return {
      remove: async () => {
        this.removedVolumes.push(name);
      }
    };
  }

  async createNetwork(config: Record<string, unknown>) {
    this.networkConfigs.push(config);
    return {};
  }

  getNetwork(name: string) {
    return {
      connect: async ({ Container }: { Container: string }) => {
        this.connectedPeers.push(Container);
      },
      disconnect: async () => undefined,
      remove: async () => {
        this.removedNetworks.push(name);
      }
    };
  }

  async createContainer(config: Record<string, unknown>) {
    this.containerConfigs.push(config);
    return {
      id: 'container-id',
      start: async () => {
        if (this.failStart) throw new Error('docker start failed');
      },
      remove: async () => {
        this.removedContainers.push('container-id');
      }
    };
  }
}

describe('DockerBackend', () => {
  it('creates a non-root, least-privilege Worker with exact limits and one run volume', async () => {
    const docker = new FakeDocker();
    const backend = new DockerBackend(docker as unknown as Docker, {
      image: 'worker:test',
      managerId: 'test',
      controlPlaneContainer: 'connector-proxy'
    });
    const request = launchRequest();

    const handle = await backend.launch(request);

    expect(docker.connectedPeers).toEqual(['connector-proxy']);
    expect(docker.networkConfigs[0]).toMatchObject({
      Driver: 'bridge',
      Internal: true
    });
    expect(docker.volumeConfigs[0]).toMatchObject({
      Driver: 'local',
      DriverOpts: {
        type: 'tmpfs',
        device: 'tmpfs',
        o: expect.stringContaining(`size=${request.resourceLimits.diskBytes}`)
      }
    });
    const container = docker.containerConfigs[0] as {
      User: string;
      Env: string[];
      HostConfig: Record<string, unknown>;
    };
    expect(container.User).toBe('1000:1000');
    expect(container.Env).toEqual([
      'KROSS_RUN_ID=run-1',
      'KROSS_GENERATION=2',
      'KROSS_LEASE_ID=lease-2',
      `KROSS_RUN_TOKEN=${request.runToken}`,
      `KROSS_RUN_SPEC_URL=${request.runSpecUrl}`,
      `KROSS_RUN_TOKEN_EXPIRES_AT=${request.tokenExpiresAt}`,
      'KROSS_PHYSICAL_WORK_ROOT=/work'
    ]);
    expect(container.HostConfig).toMatchObject({
      Binds: [`${handle.volumeName}:/work:rw`],
      Memory: request.resourceLimits.memoryBytes,
      MemorySwap: request.resourceLimits.memoryBytes,
      NanoCpus: request.resourceLimits.cpuMillis * 1_000_000,
      PidsLimit: request.resourceLimits.maxPids,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'no' }
    });
    expect(container.HostConfig.Binds).toHaveLength(1);
    expect(JSON.stringify(container)).not.toMatch(
      /OPENAI_API_KEY|ANTHROPIC_API_KEY|connector.?token/i
    );
  });

  it('keeps an internal control-plane network when external access is disabled', async () => {
    const docker = new FakeDocker();
    const backend = new DockerBackend(docker as unknown as Docker, {
      controlPlaneContainer: 'connector-proxy'
    });
    const request = { ...launchRequest(), networkAccess: 'disabled' as const };

    await backend.launch(request);

    expect(docker.networkConfigs).toHaveLength(1);
    expect(docker.networkConfigs[0]).toMatchObject({ Internal: true });
    expect(docker.connectedPeers).toEqual(['connector-proxy']);
    expect(
      (docker.containerConfigs[0]?.HostConfig as Record<string, unknown>)
        .NetworkMode
    ).toMatch(/^kross-run-net-/);
  });

  it('rolls back container, network and volume when Worker start fails', async () => {
    const docker = new FakeDocker();
    docker.failStart = true;
    const backend = new DockerBackend(docker as unknown as Docker, {
      controlPlaneContainer: 'connector-proxy'
    });

    await expect(backend.launch(launchRequest())).rejects.toThrow(
      'docker start failed'
    );

    expect(docker.removedContainers).toEqual(['container-id']);
    expect(docker.removedNetworks).toHaveLength(1);
    expect(docker.removedVolumes).toHaveLength(1);
  });

  it('rejects credential-bearing RunSpec URLs and long-lived Run tokens', async () => {
    const backend = new DockerBackend(
      new FakeDocker() as unknown as Docker,
      { controlPlaneContainer: 'connector-proxy' }
    );
    await expect(
      backend.launch({
        ...launchRequest(),
        runSpecUrl: 'https://server.internal/spec?token=secret'
      })
    ).rejects.toMatchObject({ code: 'RUN_SPEC_URL_CONTAINS_CREDENTIAL' });
    await expect(
      backend.launch({
        ...launchRequest(),
        tokenExpiresAt: new Date(Date.now() + 31 * 60_000).toISOString()
      })
    ).rejects.toMatchObject({ code: 'INVALID_RUN_TOKEN_EXPIRY' });
  });
});

function launchRequest(): RunLaunchRequest {
  return {
    runId: 'run-1',
    generation: 2,
    leaseId: 'lease-2',
    runToken: 'short-lived-run-token-with-at-least-32-bytes',
    runSpecUrl: 'https://server.internal/v2/internal/run-spec',
    tokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    networkAccess: 'connector_proxy_only',
    resourceLimits: {
      cpuMillis: 750,
      memoryBytes: 256 * 1024 * 1024,
      maxPids: 64,
      diskBytes: 512 * 1024 * 1024,
      maxDurationMs: 10 * 60_000,
      maxSourceBytes: 64 * 1024 * 1024,
      maxArtifactBytes: 64 * 1024 * 1024,
      maxEventPayloadBytes: 32 * 1024
    }
  };
}
