import { randomBytes } from 'node:crypto';

import Docker from 'dockerode';

import type { WorkspaceRecord } from './workspaceRegistry';

export interface WorkspaceLimits {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  diskBytes: number;
}

export interface CreateWorkspaceContainerInput {
  id: string;
  gitUrl: string;
  defaultBranch?: string;
  onProgress?: (
    stage: 'validating' | 'provisioning' | 'cloning' | 'starting',
    message: string
  ) => void;
  credential?:
    | { type: 'https-token'; token: string }
    | { type: 'ssh-key'; privateKey: string };
}

export interface ContainerOrchestrator {
  create(input: CreateWorkspaceContainerInput): Promise<{
    containerName: string;
    volumeName: string;
    workerToken: string;
  }>;
  start(record: WorkspaceRecord): Promise<void>;
  stop(record: WorkspaceRecord): Promise<void>;
  remove(record: WorkspaceRecord, removeVolume: boolean): Promise<void>;
  workerUrl(record: WorkspaceRecord): Promise<string>;
  inspect(record: WorkspaceRecord): Promise<{
    exists?: boolean;
    running: boolean;
    lastActiveAt?: string;
    needsRecreate?: boolean;
  }>;
  listManaged?(): Promise<Array<{
    workspaceId: string;
    containerName: string;
    running: boolean;
  }>>;
  stopManaged?(containerName: string): Promise<void>;
  removeManaged?(containerName: string): Promise<void>;
  configureWorkerEnvironment?(
    environment: Record<string, string | undefined>
  ): void;
  recreate?(record: WorkspaceRecord, start: boolean): Promise<void>;
  diagnostics?(): Promise<{
    docker: boolean;
    workerImage: boolean;
    network: boolean;
  }>;
}

export interface DockerOrchestratorOptions {
  image?: string;
  network?: string;
  managerId?: string;
  limits?: Partial<WorkspaceLimits>;
  workerEnv?: Record<string, string | undefined>;
  gatewayContainer?: string;
}

const DEFAULT_LIMITS: WorkspaceLimits = {
  memoryBytes: 2 * 1024 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
  diskBytes: 10 * 1024 * 1024 * 1024
};

export class DockerOrchestrator implements ContainerOrchestrator {
  private readonly image: string;
  private readonly network: string;
  private readonly managerId: string;
  private readonly gatewayContainer: string;
  private readonly limits: WorkspaceLimits;
  private workerEnvironment: string[];

  constructor(
    private readonly docker = new Docker(),
    options: DockerOrchestratorOptions = {}
  ) {
    this.image = options.image ?? 'kross-worker:local';
    this.network = options.network ?? 'kross-cloud';
    this.managerId = options.managerId ?? this.network;
    this.gatewayContainer =
      options.gatewayContainer ?? process.env.HOSTNAME ?? 'gateway';
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.workerEnvironment = toWorkerEnvironment(
      options.workerEnv ?? process.env
    );
  }

  async create(input: CreateWorkspaceContainerInput): Promise<{
    containerName: string;
    volumeName: string;
    workerToken: string;
  }> {
    const safeId = input.id.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const containerName = `kross-worker-${safeId}`;
    const volumeName = `kross-workspace-${safeId}`;
    const workerToken = randomBytes(32).toString('base64url');
    input.onProgress?.('validating', '正在校验仓库地址与凭据类型');
    normalizeGitUrl(input.gitUrl, input.credential);
    input.onProgress?.('provisioning', '正在准备 Docker 网络与工作区数据卷');
    await this.ensureNetwork();
    try {
      await this.ensureWorkspaceNetwork(input.id);
      await this.attachGateway(input.id);
      await this.docker.createVolume({
        Name: volumeName,
        Labels: {
          'dev.kross.workspace': input.id,
          'dev.kross.manager': this.managerId
        }
      });
      input.onProgress?.('cloning', '正在克隆 Git 仓库');
      await this.cloneRepository(volumeName, input);
      input.onProgress?.('starting', '正在启动隔离的 Agent Worker');
      const container = await this.createWorkerContainer({
        workspaceId: input.id,
        containerName,
        volumeName,
        workerToken
      });
      await container.start();
      return { containerName, volumeName, workerToken };
    } catch (error) {
      await this.docker.getVolume(volumeName).remove().catch(() => undefined);
      await this.removeWorkspaceNetwork(input.id);
      throw error;
    }
  }

  async start(record: WorkspaceRecord): Promise<void> {
    const container = this.docker.getContainer(record.containerName);
    const state = await container.inspect();
    if (!state.State.Running) await container.start();
  }

  async stop(record: WorkspaceRecord): Promise<void> {
    const container = this.docker.getContainer(record.containerName);
    const state = await container.inspect();
    if (state.State.Running) await container.stop({ t: 15 });
  }

  async remove(record: WorkspaceRecord, removeVolume: boolean): Promise<void> {
    const container = this.docker.getContainer(record.containerName);
    await container.stop({ t: 10 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
    await this.removeWorkspaceNetwork(record.workspace.id);
    if (removeVolume) {
      await this.docker
        .getVolume(record.volumeName)
        .remove()
        .catch(() => undefined);
    }
  }

  async workerUrl(record: WorkspaceRecord): Promise<string> {
    await this.ensureWorkspaceNetwork(record.workspace.id);
    await this.attachGateway(record.workspace.id);
    return `ws://${record.containerName}:8788`;
  }

  async inspect(record: WorkspaceRecord): Promise<{
    exists: boolean;
    running: boolean;
    lastActiveAt?: string;
    needsRecreate?: boolean;
  }> {
    try {
      const [state, image] = await Promise.all([
        this.docker.getContainer(record.containerName).inspect(),
        this.docker.getImage(this.image).inspect()
      ]);
      return {
        exists: true,
        running: Boolean(state.State.Running),
        lastActiveAt: state.State.StartedAt,
        needsRecreate:
          state.HostConfig.NetworkMode !==
            this.workspaceNetworkName(record.workspace.id) ||
          state.Image !== image.Id
      };
    } catch {
      return { exists: false, running: false };
    }
  }

  async listManaged(): Promise<Array<{
    workspaceId: string;
    containerName: string;
    running: boolean;
  }>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          'dev.kross.workspace',
          `dev.kross.manager=${this.managerId}`
        ]
      }
    });
    return containers.flatMap((container) => {
      const workspaceId = container.Labels?.['dev.kross.workspace'];
      const containerName = container.Names?.[0]?.replace(/^\//, '');
      if (!workspaceId || !containerName) return [];
      return [{
        workspaceId,
        containerName,
        running: container.State === 'running'
      }];
    });
  }

  async stopManaged(containerName: string): Promise<void> {
    const container = this.docker.getContainer(containerName);
    const state = await container.inspect();
    if (state.State.Running) await container.stop({ t: 15 });
  }

  async removeManaged(containerName: string): Promise<void> {
    const container = this.docker.getContainer(containerName);
    const state = await container.inspect().catch(() => undefined);
    const workspaceId = state?.Config?.Labels?.['dev.kross.workspace'];
    await container.stop({ t: 15 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
    if (workspaceId) await this.removeWorkspaceNetwork(workspaceId);
  }

  configureWorkerEnvironment(
    environment: Record<string, string | undefined>
  ): void {
    this.workerEnvironment = toWorkerEnvironment(environment);
  }

  async recreate(record: WorkspaceRecord, start: boolean): Promise<void> {
    const previous = this.docker.getContainer(record.containerName);
    await previous.stop({ t: 15 }).catch(() => undefined);
    await previous.remove({ force: true }).catch(() => undefined);
    await this.ensureWorkspaceNetwork(record.workspace.id);
    await this.attachGateway(record.workspace.id);
    const replacement = await this.createWorkerContainer({
      workspaceId: record.workspace.id,
      containerName: record.containerName,
      volumeName: record.volumeName,
      workerToken: record.workerToken
    });
    if (start) await replacement.start();
  }

  async diagnostics(): Promise<{
    docker: boolean;
    workerImage: boolean;
    network: boolean;
  }> {
    try {
      await this.docker.ping();
    } catch {
      return { docker: false, workerImage: false, network: false };
    }
    const [workerImage, networks] = await Promise.all([
      this.docker
        .getImage(this.image)
        .inspect()
        .then(() => true)
        .catch(() => false),
      this.docker
        .listNetworks({ filters: { name: [this.network] } })
        .catch(() => [])
    ]);
    return {
      docker: true,
      workerImage,
      network: networks.some((network) => network.Name === this.network)
    };
  }

  private createWorkerContainer(input: {
    workspaceId: string;
    containerName: string;
    volumeName: string;
    workerToken: string;
  }) {
    return this.docker.createContainer({
      name: input.containerName,
      Image: this.image,
      Env: [
        `KROSS_WORKSPACE_ID=${input.workspaceId}`,
        'KROSS_WORKSPACE_ROOT=/workspace/repo',
        'KROSS_HOME=/workspace/.kross',
        `KROSS_WORKER_TOKEN=${input.workerToken}`,
        `KROSS_WORKSPACE_DISK_BYTES=${this.limits.diskBytes}`,
        'PORT=8788',
        ...this.workerEnvironment
      ],
      Labels: {
        'dev.kross.workspace': input.workspaceId,
        'dev.kross.manager': this.managerId
      },
      HostConfig: {
        Binds: [`${input.volumeName}:/workspace`],
        NetworkMode: this.workspaceNetworkName(input.workspaceId),
        Memory: this.limits.memoryBytes,
        NanoCpus: this.limits.nanoCpus,
        PidsLimit: this.limits.pidsLimit,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        RestartPolicy: { Name: 'unless-stopped' }
      },
      ExposedPorts: { '8788/tcp': {} }
    });
  }

  private async ensureNetwork(): Promise<void> {
    const networks = await this.docker.listNetworks({
      filters: { name: [this.network] }
    });
    if (!networks.some((network) => network.Name === this.network)) {
      await this.docker.createNetwork({
        Name: this.network,
        Driver: 'bridge',
        Internal: false,
        Labels: {
          'dev.kross.managed': 'true',
          'dev.kross.manager': this.managerId
        }
      });
    }
  }

  private async ensureWorkspaceNetwork(workspaceId: string): Promise<void> {
    const name = this.workspaceNetworkName(workspaceId);
    const networks = await this.docker.listNetworks({
      filters: { name: [name] }
    });
    if (!networks.some((network) => network.Name === name)) {
      await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        Internal: false,
        Labels: {
          'dev.kross.managed': 'true',
          'dev.kross.manager': this.managerId,
          'dev.kross.workspace': workspaceId
        }
      });
    }
  }

  private async attachGateway(workspaceId: string): Promise<void> {
    const network = this.docker.getNetwork(
      this.workspaceNetworkName(workspaceId)
    );
    const [networkState, gatewayState] = await Promise.all([
      network.inspect(),
      this.docker.getContainer(this.gatewayContainer).inspect()
    ]);
    if (networkState.Containers?.[gatewayState.Id]) return;
    await network.connect({ Container: gatewayState.Id });
  }

  private async removeWorkspaceNetwork(workspaceId: string): Promise<void> {
    const network = this.docker.getNetwork(
      this.workspaceNetworkName(workspaceId)
    );
    await network
      .disconnect({ Container: this.gatewayContainer, Force: true })
      .catch(() => undefined);
    await network.remove().catch(() => undefined);
  }

  private workspaceNetworkName(workspaceId: string): string {
    const safeId = workspaceId.replace(/[^a-zA-Z0-9_.-]/g, '-');
    return `kross-workspace-net-${safeId}`.slice(0, 63);
  }

  private async cloneRepository(
    volumeName: string,
    input: CreateWorkspaceContainerInput
  ): Promise<void> {
    const environment: string[] = [];
    environment.push(
      `KROSS_DISK_LIMIT_KIB=${Math.floor(this.limits.diskBytes / 1024)}`
    );
    const cloneUrl = normalizeGitUrl(input.gitUrl, input.credential);
    const credentialInput =
      input.credential?.type === 'https-token'
        ? Buffer.from(input.credential.token).toString('base64')
        : input.credential?.type === 'ssh-key'
          ? Buffer.from(input.credential.privateKey).toString('base64')
          : undefined;
    const branchArgs = input.defaultBranch
      ? ['--branch', input.defaultBranch]
      : [];
    const quotaCheck =
      'used="$(du -sk /workspace | cut -f1)"; if [ "$used" -gt "$KROSS_DISK_LIMIT_KIB" ]; then echo "workspace disk quota exceeded" >&2; exit 42; fi';
    const command =
      input.credential?.type === 'ssh-key'
        ? [
            `umask 077; IFS= read -r secret; mkdir -p /workspace/.kross/ssh; printf %s "$secret" | base64 -d > /workspace/.kross/ssh/id_ed25519; unset secret; GIT_SSH_COMMAND="ssh -i /workspace/.kross/ssh/id_ed25519 -o UserKnownHostsFile=/workspace/.kross/ssh/known_hosts -o StrictHostKeyChecking=accept-new" git clone "$@" /workspace/repo; chown -R 1000:1000 /workspace; ${quotaCheck}`,
            'clone',
            ...branchArgs,
            '--',
            cloneUrl
          ]
        : input.credential?.type === 'https-token'
          ? [
              `umask 077; IFS= read -r secret; mkdir -p /workspace/.kross; printf %s "$secret" | base64 -d > /workspace/.kross/git-token; unset secret; printf '#!/bin/sh\\ncase "$1" in *Username*) printf %s x-access-token;; *) cat /workspace/.kross/git-token;; esac\\n' > /workspace/.kross/git-askpass.sh; chmod 700 /workspace/.kross/git-askpass.sh; GIT_ASKPASS=/workspace/.kross/git-askpass.sh GIT_TERMINAL_PROMPT=0 git clone "$@" /workspace/repo; chown -R 1000:1000 /workspace; ${quotaCheck}`,
              'clone',
              ...branchArgs,
              '--',
              cloneUrl
            ]
          : [
              `git clone "$@" /workspace/repo; chown -R 1000:1000 /workspace; ${quotaCheck}`,
              'clone',
              ...branchArgs,
              '--',
              cloneUrl
            ];
    const helper = await this.docker.createContainer({
      Image: this.image,
      User: '0:0',
      Entrypoint: ['/bin/sh', '-ec'],
      Cmd: command,
      Env: environment,
      OpenStdin: Boolean(credentialInput),
      StdinOnce: Boolean(credentialInput),
      HostConfig: {
        Binds: [`${volumeName}:/workspace`],
        AutoRemove: false,
        NetworkMode: this.network
      }
    });
    try {
      const stdin = credentialInput
        ? await helper.attach({
            stream: true,
            stdin: true,
            stdout: false,
            stderr: false,
            hijack: true
          })
        : undefined;
      await helper.start();
      stdin?.end(`${credentialInput}\n`);
      const result = await helper.wait();
      if (result.StatusCode !== 0) {
        if (result.StatusCode === 42) {
          throw new Error(
            `仓库超过工作区磁盘配额（${Math.floor(
              this.limits.diskBytes / 1024 ** 3
            )} GiB）`
          );
        }
        throw new Error(`Git clone 失败，退出码 ${result.StatusCode}`);
      }
    } finally {
      await helper.remove({ force: true }).catch(() => undefined);
    }
  }
}

export function normalizeGitUrl(
  value: string,
  credential?: CreateWorkspaceContainerInput['credential']
): string {
  const trimmed = value.trim();
  if (/^[\w.-]+@[\w.-]+:.+/.test(trimmed)) {
    if (credential?.type === 'https-token') {
      throw new Error('HTTPS Token 不能与 SSH Git URL 一起使用');
    }
    return trimmed;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Git URL 必须是 HTTPS、SSH 或标准 scp 风格地址');
  }
  if (
    url.password ||
    ((url.protocol === 'https:' || url.protocol === 'http:') && url.username)
  ) {
    throw new Error('Git URL 不得内嵌凭证，请使用 credential 字段');
  }
  if (credential?.type === 'https-token' && url.protocol !== 'https:') {
    throw new Error('HTTPS Token 只能用于 https:// Git URL');
  }
  if (
    credential?.type === 'ssh-key' &&
    !['ssh:', 'git+ssh:'].includes(url.protocol)
  ) {
    throw new Error('SSH 私钥只能用于 SSH Git URL');
  }
  if (!['https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) {
    throw new Error(`不支持的 Git URL 协议: ${url.protocol}`);
  }
  return url.toString();
}

const WORKER_ENV_ALLOWLIST = [
  'AGENT_LLM_PROVIDER',
  'AGENT_LLM_MODEL',
  'AGENT_LLM_BACKEND',
  'AGENT_THINKING_EFFORT',
  'AGENT_CONTEXT_WINDOW',
  'KROSS_THINKING_EFFORT',
  'KROSS_CONTEXT_WINDOW',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_VERSION',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'OPENROUTER_BASE_URL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_BASE_URL',
  'XAI_API_KEY',
  'XAI_MODEL',
  'XAI_BASE_URL',
  'GH_TOKEN'
] as const;

export function selectWorkerEnvironment(
  environment: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    WORKER_ENV_ALLOWLIST.flatMap((name) => {
      const value = environment[name];
      return value ? [[name, value]] : [];
    })
  );
}

function toWorkerEnvironment(
  environment: Record<string, string | undefined>
): string[] {
  return Object.entries(selectWorkerEnvironment(environment))
    .map(([name, value]) => `${name}=${value}`);
}
