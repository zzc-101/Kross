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

  async listNetworks() {
    return [{ Name: 'kross-cloud' }];
  }

  async createNetwork() {
    throw new Error('network already exists');
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
      wait: async () => ({ StatusCode: 0 }),
      remove: async () => undefined,
      ...(helper ? {} : { id: 'worker' })
    };
  }
}

describe('DockerOrchestrator', () => {
  it('creates an isolated, resource-limited worker on the shared network', async () => {
    const docker = new FakeDocker();
    const orchestrator = new DockerOrchestrator(
      docker as unknown as Docker,
      {
        image: 'worker:test',
        network: 'kross-cloud',
        managerId: 'test-manager',
        workerEnv: {
          AGENT_LLM_PROVIDER: 'openai',
          OPENAI_API_KEY: 'provider-secret'
        },
        limits: {
          memoryBytes: 1024,
          nanoCpus: 2_000,
          pidsLimit: 32
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
    const helper = docker.configs[0];
    const worker = docker.configs[1];
    expect(helper?.Image).toBe('worker:test');
    expect(helper?.User).toBe('0:0');
    expect(JSON.stringify(helper?.Cmd)).not.toContain('git-secret');
    expect(helper?.Env).toContain('KROSS_GIT_TOKEN=git-secret');
    expect(worker?.Image).toBe('worker:test');
    expect(worker?.Labels).toMatchObject({
      'dev.kross.workspace': 'workspace-1',
      'dev.kross.manager': 'test-manager'
    });
    expect(worker?.Env).toEqual(
      expect.arrayContaining([
        'KROSS_WORKSPACE_ID=workspace-1',
        'AGENT_LLM_PROVIDER=openai',
        'OPENAI_API_KEY=provider-secret'
      ])
    );
    expect(worker?.HostConfig).toMatchObject({
      NetworkMode: 'kross-cloud',
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
      { network: 'kross-cloud' }
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
    expect(helper?.Env).toContain('KROSS_SSH_KEY=PRIVATE-KEY-CONTENT');
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
