import Docker from 'dockerode';
import { describe, expect, it } from 'vitest';

import {
  DockerOrchestrator,
  normalizeGitUrl,
  selectWorkerEnvironment
} from './containerOrchestrator';

class FakeDocker {
  readonly configs: Array<Record<string, unknown>> = [];
  readonly volumes: string[] = [];
  readonly networks = new Map<string, Set<string>>([
    ['kross-cloud', new Set()]
  ]);
  readonly stdin: string[] = [];

  async listNetworks(input?: { filters?: { name?: string[] } }) {
    const names = input?.filters?.name;
    return [...this.networks.keys()]
      .filter((name) => !names || names.includes(name))
      .map((Name) => ({ Name }));
  }

  async createNetwork(input: { Name: string }) {
    this.networks.set(input.Name, new Set());
    return {};
  }

  getNetwork(name: string) {
    return {
      inspect: async () => ({
        Containers: Object.fromEntries(
          [...(this.networks.get(name) ?? [])].map((id) => [id, {}])
        )
      }),
      connect: async ({ Container }: { Container: string }) => {
        this.networks.get(name)?.add(Container);
      },
      disconnect: async ({ Container }: { Container: string }) => {
        this.networks.get(name)?.delete(Container);
      },
      remove: async () => {
        this.networks.delete(name);
      }
    };
  }

  getContainer(name: string) {
    return {
      inspect: async () => ({ Id: name })
    };
  }

  async createVolume(input: { Name: string }) {
    this.volumes.push(input.Name);
    return {};
  }

  getVolume() {
    return { remove: async () => undefined };
  }

  async createContainer(config: Record<string, unknown>) {
    this.configs.push(config);
    const helper = this.configs.length === 1;
    return {
      start: async () => undefined,
      attach: async () => ({
        end: (value: string) => this.stdin.push(value)
      }),
      wait: async () => ({ StatusCode: 0 }),
      remove: async () => undefined,
      ...(helper ? {} : { id: 'worker' })
    };
  }
}

describe('DockerOrchestrator', () => {
  it('creates an isolated, resource-limited worker on a workspace network', async () => {
    const docker = new FakeDocker();
    const orchestrator = new DockerOrchestrator(
      docker as unknown as Docker,
      {
        image: 'worker:test',
        network: 'kross-cloud',
        managerId: 'test-manager',
        gatewayContainer: 'gateway-id',
        workerEnv: {
          AGENT_LLM_PROVIDER: 'openai',
          OPENAI_API_KEY: 'provider-secret'
        },
        limits: {
          memoryBytes: 1024,
          nanoCpus: 2_000,
          pidsLimit: 32,
          diskBytes: 4096
        }
      }
    );
    const progress: string[] = [];

    const result = await orchestrator.create({
      id: 'workspace-1',
      gitUrl: 'https://example.com/repo.git',
      credential: { type: 'https-token', token: 'git-secret' },
      onProgress: (stage) => progress.push(stage)
    });

    expect(docker.volumes).toEqual(['kross-workspace-workspace-1']);
    expect(docker.networks.has('kross-workspace-net-workspace-1')).toBe(true);
    expect(
      docker.networks.get('kross-workspace-net-workspace-1')
    ).toContain('gateway-id');
    const helper = docker.configs[0];
    const worker = docker.configs[1];
    expect(helper?.Image).toBe('worker:test');
    expect(helper?.User).toBe('0:0');
    expect(JSON.stringify(helper?.Cmd)).not.toContain('git-secret');
    expect(helper?.Env).not.toContain('KROSS_GIT_TOKEN=git-secret');
    expect(
      Buffer.from(docker.stdin[0]!.trim(), 'base64').toString('utf8')
    ).toBe('git-secret');
    expect(helper?.Env).toContain('KROSS_DISK_LIMIT_KIB=4');
    expect(JSON.stringify(helper?.Cmd)).toContain('du -sk /workspace');
    expect(worker?.Image).toBe('worker:test');
    expect(worker?.Labels).toMatchObject({
      'dev.kross.workspace': 'workspace-1',
      'dev.kross.manager': 'test-manager'
    });
    expect(worker?.Env).toEqual(
      expect.arrayContaining([
        'KROSS_WORKSPACE_ID=workspace-1',
        'KROSS_WORKSPACE_DISK_BYTES=4096',
        'AGENT_LLM_PROVIDER=openai',
        'OPENAI_API_KEY=provider-secret'
      ])
    );
    expect(worker?.HostConfig).toMatchObject({
      NetworkMode: 'kross-workspace-net-workspace-1',
      Memory: 1024,
      NanoCpus: 2_000,
      PidsLimit: 32,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true']
    });
    expect(result.workerToken.length).toBeGreaterThan(30);
    expect(progress).toEqual([
      'validating',
      'provisioning',
      'cloning',
      'starting'
    ]);
  });

  it('only forwards explicitly allowed worker environment variables', () => {
    expect(
      selectWorkerEnvironment({
        OPENAI_API_KEY: 'key',
        AGENT_LLM_MODEL: 'model',
        GH_TOKEN: 'github-token',
        KROSS_ACCESS_TOKEN: 'must-not-leak',
        PATH: '/bin'
      })
    ).toEqual({
      OPENAI_API_KEY: 'key',
      AGENT_LLM_MODEL: 'model',
      GH_TOKEN: 'github-token'
    });
  });

  it('persists SSH credentials only inside the workspace volume', async () => {
    const docker = new FakeDocker();
    const orchestrator = new DockerOrchestrator(
      docker as unknown as Docker,
      { network: 'kross-cloud', gatewayContainer: 'gateway-id' }
    );

    await orchestrator.create({
      id: 'ssh-workspace',
      gitUrl: 'git@example.com:org/repo.git',
      credential: {
        type: 'ssh-key',
        privateKey: 'PRIVATE-KEY-CONTENT'
      }
    });

    const helper = docker.configs[0];
    expect(JSON.stringify(helper?.Cmd)).not.toContain('PRIVATE-KEY-CONTENT');
    expect(helper?.Env).not.toContain('KROSS_SSH_KEY=PRIVATE-KEY-CONTENT');
    expect(
      Buffer.from(docker.stdin[0]!.trim(), 'base64').toString('utf8')
    ).toBe('PRIVATE-KEY-CONTENT');
    expect(JSON.stringify(helper?.Cmd)).toContain(
      '/workspace/.kross/ssh/id_ed25519'
    );
  });

  it('rejects embedded credentials and unsafe repository URL schemes', () => {
    expect(() =>
      normalizeGitUrl('https://user:secret@example.com/repo.git')
    ).toThrow('不得内嵌凭证');
    expect(() =>
      normalizeGitUrl('file:///etc/passwd')
    ).toThrow('不支持的 Git URL 协议');
    expect(() =>
      normalizeGitUrl('ssh://git@example.com/repo.git', {
        type: 'https-token',
        token: 'secret'
      })
    ).toThrow('HTTPS Token');
    expect(() =>
      normalizeGitUrl('https://example.com/repo.git', {
        type: 'ssh-key',
        privateKey: 'secret'
      })
    ).toThrow('SSH 私钥');
  });
});
