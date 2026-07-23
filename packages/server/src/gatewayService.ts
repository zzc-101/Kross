import { randomBytes, randomUUID } from 'node:crypto';

import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type CloudWorkspace,
  type EventEnvelope,
  type SessionSnapshot
} from '@kross/protocol';

import type {
  ContainerOrchestrator,
  CreateWorkspaceContainerInput
} from './containerOrchestrator';
import { WorkerClient } from './workerClient';
import {
  WorkspaceRegistry,
  type WorkspaceRecord
} from './workspaceRegistry';
import type { PushService } from './pushService';
import {
  type PublicProviderConfig,
  type RuntimeConfigStore,
  providerUpdateSchema
} from './runtimeConfig';

export type GatewaySink = (event: EventEnvelope) => void;

export interface GatewayServiceOptions {
  stopWorkersOnClose?: boolean;
  runtimeConfig?: RuntimeConfigStore;
}

export class GatewayService {
  private readonly clients = new Map<string, WorkerClient>();
  private readonly sinks = new Set<GatewaySink>();

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly orchestrator: ContainerOrchestrator,
    private readonly now: () => Date = () => new Date(),
    private readonly pushService?: PushService,
    private readonly options: GatewayServiceOptions = {}
  ) {
    this.options = {
      stopWorkersOnClose: true,
      ...options
    };
  }

  listWorkspaces(): CloudWorkspace[] {
    return this.registry.list();
  }

  subscribe(sink: GatewaySink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  broadcast(event: EventEnvelope, direct?: GatewaySink): void {
    direct?.(event);
    for (const sink of this.sinks) {
      if (sink !== direct) sink(event);
    }
  }

  initialEvent(): EventEnvelope {
    return this.envelope(undefined, {
      type: 'workspace.list',
      data: this.registry.list()
    });
  }

  getPushPublicKey(): string | undefined {
    return this.pushService?.publicKey;
  }

  async getSetupStatus(secureTransport: boolean): Promise<{
    ready: boolean;
    provider: PublicProviderConfig;
    checks: Array<{
      id: string;
      label: string;
      status: 'passed' | 'warning' | 'failed';
      detail: string;
    }>;
  }> {
    const provider =
      this.options.runtimeConfig?.publicProvider() ??
      { hasApiKey: false, source: 'none' as const };
    const docker =
      await this.orchestrator.diagnostics?.() ??
      { docker: true, workerImage: true, network: true };
    const checks = [
      {
        id: 'docker',
        label: 'Docker Engine',
        status: docker.docker ? 'passed' as const : 'failed' as const,
        detail: docker.docker ? 'Docker 连接正常' : '无法连接 Docker Engine'
      },
      {
        id: 'worker-image',
        label: 'Worker 镜像',
        status: docker.workerImage ? 'passed' as const : 'failed' as const,
        detail: docker.workerImage
          ? 'Worker 镜像已就绪'
          : '缺少 Worker 镜像，请先执行 Compose build'
      },
      {
        id: 'provider',
        label: '模型 Provider',
        status:
          provider.hasApiKey && provider.model
            ? 'passed' as const
            : 'warning' as const,
        detail:
          provider.hasApiKey && provider.model
            ? `${provider.provider} · ${provider.model}`
            : '尚未配置模型，无法执行 Agent 任务'
      },
      {
        id: 'github',
        label: 'GitHub 集成',
        status: this.options.runtimeConfig?.hasEnvironment('GH_TOKEN')
          ? 'passed' as const
          : 'warning' as const,
        detail: this.options.runtimeConfig?.hasEnvironment('GH_TOKEN')
          ? 'GH_TOKEN 已配置'
          : '未配置 GH_TOKEN，不能自动创建 Pull Request'
      },
      {
        id: 'push',
        label: 'Web Push',
        status: this.pushService ? 'passed' as const : 'warning' as const,
        detail: this.pushService
          ? '通知服务已配置'
          : '未配置 VAPID，审批通知不可用'
      },
      {
        id: 'transport',
        label: '安全传输',
        status: secureTransport ? 'passed' as const : 'warning' as const,
        detail: secureTransport
          ? '当前使用安全传输'
          : '当前为 HTTP，仅建议在 localhost 使用'
      }
    ];
    return {
      ready: docker.docker && docker.workerImage &&
        Boolean(provider.hasApiKey && provider.model),
      provider,
      checks
    };
  }

  async updateProvider(
    input: unknown,
    restartWorkers: boolean
  ): Promise<{
    provider: PublicProviderConfig;
    restarted: string[];
  }> {
    const store = this.options.runtimeConfig;
    if (!store) throw new Error('Gateway 未启用运行时配置存储');
    const provider = store.update(providerUpdateSchema.parse(input));
    this.orchestrator.configureWorkerEnvironment?.(
      store.workerEnvironment()
    );
    const restarted: string[] = [];
    if (restartWorkers) {
      if (!this.orchestrator.recreate) {
        throw new Error('当前调度器不支持重建 Worker');
      }
      for (const workspace of this.registry.list()) {
        const record = this.registry.get(workspace.id);
        if (!record) continue;
        this.clients.get(workspace.id)?.close();
        this.clients.delete(workspace.id);
        await this.orchestrator.recreate(
          record,
          workspace.status === 'ready'
        );
        restarted.push(workspace.id);
      }
    }
    return { provider, restarted };
  }

  async listSessions(
    workspaceId: string,
    limit = 20
  ): Promise<SessionSnapshot['summary'][]> {
    const event = await this.requestWorker(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        type: 'session.list',
        workspaceId,
        limit: Math.max(1, Math.min(100, Math.floor(limit)))
      },
      (candidate) => candidate.event.type === 'session.list'
    );
    return event.event.type === 'session.list' ? event.event.data : [];
  }

  async inspectSession(
    workspaceId: string,
    sessionId: string,
    kind: 'trace' | 'diff',
    argument?: string
  ): Promise<string> {
    const event = await this.requestWorker(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        type: 'session.inspect',
        workspaceId,
        sessionId,
        kind,
        argument
      },
      (candidate) =>
        candidate.event.type === 'inspection.result' &&
        candidate.event.data.kind === kind
    );
    if (event.event.type !== 'inspection.result') {
      throw new Error('worker 未返回检查结果');
    }
    return event.event.data.kind === 'trace'
      ? event.event.data.content
      : [
          event.event.data.summary,
          ...event.event.data.patches.map(
            (patch) =>
              `${patch.staged ? '# 已暂存变更' : '# 未暂存变更'}\n${patch.patch}`
          )
        ].join('\n\n');
  }

  async isWorkspaceBusy(workspaceId: string): Promise<boolean> {
    const event = await this.requestWorker(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        type: 'workspace.status',
        workspaceId
      },
      (candidate) => candidate.event.type === 'workspace.runtime-status',
      5_000
    );
    return (
      event.event.type === 'workspace.runtime-status' &&
      event.event.data.activeRuns > 0
    );
  }

  releaseWorkspaceConnection(workspaceId: string): void {
    this.clients.get(workspaceId)?.close();
    this.clients.delete(workspaceId);
  }

  async handle(
    command: ClientCommand,
    sink: GatewaySink = () => undefined
  ): Promise<void> {
    const respond: GatewaySink = (event) =>
      this.broadcast(
        { ...event, correlationId: command.requestId },
        sink
      );
    switch (command.type) {
      case 'workspace.list':
        respond(
          this.envelope(undefined, {
            type: 'workspace.list',
            data: this.registry.list()
          })
        );
        return;
      case 'workspace.create':
        await this.createWorkspace(command, respond);
        return;
      case 'workspace.start':
        await this.changeLifecycle(command.workspaceId, 'start', command.requestId, respond);
        return;
      case 'workspace.stop':
        await this.changeLifecycle(command.workspaceId, 'stop', command.requestId, respond);
        return;
      case 'workspace.delete':
        await this.deleteWorkspace(
          command.workspaceId,
          command.removeVolume,
          command.requestId,
          respond
        );
        return;
      case 'push.subscribe':
        if (!this.pushService) {
          respond(this.error(undefined, command.requestId, 'NOT_CONFIGURED', '尚未配置 Web Push'));
          return;
        }
        this.pushService.subscribe(command.subscription);
        respond(this.envelope(undefined, {
          type: 'request.accepted',
          requestId: command.requestId
        }));
        return;
      default:
        await this.forward(command.workspaceId, command, respond);
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    if (this.options.stopWorkersOnClose) {
      await this.stopAllManagedWorkers();
    }
  }

  async reconcileWorkspaces(): Promise<{
    running: number;
    stopped: number;
    missing: number;
    orphaned: number;
  }> {
    let running = 0;
    let stopped = 0;
    let missing = 0;
    const records = this.registry
      .list()
      .flatMap((workspace) => {
        const record = this.registry.get(workspace.id);
        return record ? [record] : [];
      });
    for (const record of records) {
      const state = await this.orchestrator.inspect(record);
      if (state.exists === false) {
        if (this.orchestrator.recreate) {
          const shouldStart = record.workspace.status === 'ready';
          await this.orchestrator.recreate(record, shouldStart);
          record.workspace.status = shouldStart ? 'ready' : 'stopped';
          record.workspace.error = undefined;
          if (shouldStart) running += 1;
          else stopped += 1;
        } else {
          record.workspace.status = 'error';
          record.workspace.error = 'Worker 容器不存在，请删除后重新创建工作区';
          missing += 1;
        }
      } else if (state.needsRecreate && this.orchestrator.recreate) {
        const shouldStart = record.workspace.status === 'ready';
        this.releaseWorkspaceConnection(record.workspace.id);
        await this.orchestrator.recreate(record, shouldStart);
        if (shouldStart) running += 1;
        else stopped += 1;
      } else if (record.workspace.status === 'stopped') {
        if (state.running) await this.orchestrator.stop(record);
        stopped += 1;
      } else if (state.running) {
        record.workspace.status = 'ready';
        record.workspace.error = undefined;
        running += 1;
      } else {
        record.workspace.status = 'stopped';
        record.workspace.error = undefined;
        stopped += 1;
      }
      record.workspace.updatedAt = this.now().toISOString();
      this.registry.put(record);
      if (record.workspace.status === 'ready' && this.pushService) {
        const client = await this.client(record);
        client.start();
      }
    }
    const knownIds = new Set(records.map((record) => record.workspace.id));
    const managed = await this.orchestrator.listManaged?.() ?? [];
    const orphans = managed.filter((container) => !knownIds.has(container.workspaceId));
    for (const orphan of orphans) {
      if (this.orchestrator.removeManaged) {
        await this.orchestrator.removeManaged(orphan.containerName);
      } else if (orphan.running) {
        await this.orchestrator.stopManaged?.(orphan.containerName);
      }
    }
    return { running, stopped, missing, orphaned: orphans.length };
  }

  private requestWorker(
    command: ClientCommand,
    matches: (event: EventEnvelope) => boolean,
    timeoutMs = 15_000
  ): Promise<EventEnvelope> {
    return new Promise<EventEnvelope>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          unsubscribe();
          reject(new Error('worker 请求超时'));
        },
        timeoutMs
      );
      const settle = (event: EventEnvelope) => {
        if (event.correlationId !== command.requestId) return;
        if (
          event.event.type === 'request.error' &&
          event.event.requestId === command.requestId
        ) {
          clearTimeout(timer);
          unsubscribe();
          reject(new Error(event.event.message));
          return;
        }
        if (matches(event)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        }
      };
      const unsubscribe = this.subscribe(settle);
      void this.handle(command, settle).catch((error) => {
        clearTimeout(timer);
        unsubscribe();
        reject(error);
      });
    });
  }

  private async createWorkspace(
    command: Extract<ClientCommand, { type: 'workspace.create' }>,
    sink: GatewaySink
  ): Promise<void> {
    const id = `ws-${randomUUID()}`;
    const timestamp = this.now().toISOString();
    const workspace: CloudWorkspace = {
      id,
      name: command.name,
      gitUrl: redactGitUrl(command.gitUrl),
      defaultBranch: command.defaultBranch,
      status: 'creating',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    sink(this.envelope(undefined, { type: 'workspace.updated', data: workspace }));
    const progress = (
      stage: 'validating' | 'provisioning' | 'cloning' | 'starting' | 'ready' | 'failed',
      message: string
    ) => {
      sink(this.envelope(undefined, {
        type: 'workspace.progress',
        data: {
          requestId: command.requestId,
          workspaceId: id,
          name: command.name,
          stage,
          message
        }
      }));
    };
    try {
      const created = await this.orchestrator.create({
        id,
        gitUrl: command.gitUrl,
        defaultBranch: command.defaultBranch,
        credential: command.credential,
        onProgress: progress
      });
      const ready: WorkspaceRecord = {
        workspace: {
          ...workspace,
          status: 'ready',
          updatedAt: this.now().toISOString(),
          lastActiveAt: this.now().toISOString()
        },
        ...created
      };
      this.registry.put(ready);
      progress('ready', '工作区已就绪');
      sink(this.envelope(undefined, { type: 'workspace.updated', data: ready.workspace }));
      sink(this.envelope(undefined, { type: 'request.accepted', requestId: command.requestId }));
    } catch (error) {
      const failed: CloudWorkspace = {
        ...workspace,
        status: 'error',
        updatedAt: this.now().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      progress('failed', failed.error ?? '工作区创建失败');
      sink(this.envelope(undefined, { type: 'workspace.updated', data: failed }));
      sink(this.error(undefined, command.requestId, 'WORKSPACE_CREATE_FAILED', failed.error ?? '创建失败'));
    }
  }

  private async changeLifecycle(
    workspaceId: string,
    operation: 'start' | 'stop',
    requestId: string,
    sink: GatewaySink
  ): Promise<void> {
    const record = this.registry.get(workspaceId);
    if (!record) {
      sink(this.error(workspaceId, requestId, 'WORKSPACE_NOT_FOUND', '工作区不存在'));
      return;
    }
    if (operation === 'start') await this.orchestrator.start(record);
    else {
      this.clients.get(workspaceId)?.close();
      this.clients.delete(workspaceId);
      await this.orchestrator.stop(record);
    }
    record.workspace.status = operation === 'start' ? 'ready' : 'stopped';
    record.workspace.updatedAt = this.now().toISOString();
    this.registry.put(record);
    sink(this.envelope(workspaceId, { type: 'workspace.updated', data: record.workspace }));
    sink(this.envelope(workspaceId, { type: 'request.accepted', requestId }));
  }

  private async deleteWorkspace(
    workspaceId: string,
    removeVolume: boolean,
    requestId: string,
    sink: GatewaySink
  ): Promise<void> {
    const record = this.registry.get(workspaceId);
    if (!record) {
      sink(this.error(workspaceId, requestId, 'WORKSPACE_NOT_FOUND', '工作区不存在'));
      return;
    }
    this.clients.get(workspaceId)?.close();
    this.clients.delete(workspaceId);
    await this.orchestrator.remove(record, removeVolume);
    this.registry.delete(workspaceId);
    sink(this.envelope(workspaceId, { type: 'request.accepted', requestId }));
    sink(this.envelope(undefined, {
      type: 'workspace.list',
      data: this.registry.list()
    }));
  }

  private async forward(
    workspaceId: string,
    command: ClientCommand,
    sink: GatewaySink
  ): Promise<void> {
    const record = this.registry.get(workspaceId);
    if (!record) {
      sink(this.error(workspaceId, command.requestId, 'WORKSPACE_NOT_FOUND', '工作区不存在'));
      return;
    }
    if (record.workspace.status === 'stopped') {
      await this.orchestrator.start(record);
      record.workspace.status = 'ready';
    }
    record.workspace.lastActiveAt = this.now().toISOString();
    record.workspace.updatedAt = record.workspace.lastActiveAt;
    this.registry.put(record);
    const client = await this.client(record);
    try {
      await client.send(command);
    } catch (error) {
      sink(
        this.error(
          workspaceId,
          command.requestId,
          'WORKER_UNAVAILABLE',
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  private async client(record: WorkspaceRecord): Promise<WorkerClient> {
    const cached = this.clients.get(record.workspace.id);
    if (cached) return cached;
    const client = new WorkerClient(
      await this.orchestrator.workerUrl(record),
      record.workerToken,
      record.workspace.id
    );
    client.subscribe((event) => {
      this.touchWorkspace(record.workspace.id);
      this.broadcast(event);
      if (event.event.type === 'approval.pending') {
        void this.pushService?.notifyApproval({
          workspaceId: record.workspace.id,
          sessionId: event.sessionId,
          runId: event.event.data.runId,
          toolName: event.event.data.toolName,
          risk: event.event.data.risk
        });
      }
    });
    this.clients.set(record.workspace.id, client);
    return client;
  }

  private touchWorkspace(workspaceId: string): void {
    const record = this.registry.get(workspaceId);
    if (!record) return;
    const now = this.now();
    if (
      record.workspace.lastActiveAt &&
      now.getTime() - Date.parse(record.workspace.lastActiveAt) < 30_000
    ) {
      return;
    }
    record.workspace.lastActiveAt = now.toISOString();
    record.workspace.updatedAt = record.workspace.lastActiveAt;
    this.registry.put(record);
  }

  private async stopAllManagedWorkers(): Promise<void> {
    const records = this.registry
      .list()
      .flatMap((workspace) => {
        const record = this.registry.get(workspace.id);
        return record ? [record] : [];
      });
    for (const record of records) {
      await this.orchestrator.remove(record, false).catch(() => undefined);
      record.workspace.status = 'stopped';
      record.workspace.updatedAt = this.now().toISOString();
      this.registry.put(record);
    }
    const knownNames = new Set(records.map((record) => record.containerName));
    const managed = await this.orchestrator.listManaged?.().catch(() => []) ?? [];
    for (const container of managed) {
      if (!knownNames.has(container.containerName)) {
        if (this.orchestrator.removeManaged) {
          await this.orchestrator
            .removeManaged(container.containerName)
            .catch(() => undefined);
        } else if (container.running) {
          await this.orchestrator
            .stopManaged?.(container.containerName)
            .catch(() => undefined);
        }
      }
    }
  }

  private envelope(
    workspaceId: string | undefined,
    event: EventEnvelope['event']
  ): EventEnvelope {
    return {
      protocolVersion: PROTOCOL_VERSION,
      source: 'gateway',
      workspaceId: workspaceId ?? '$gateway',
      seq: 0,
      timestamp: this.now().toISOString(),
      event
    };
  }

  private error(
    workspaceId: string | undefined,
    requestId: string,
    code: string,
    message: string
  ): EventEnvelope {
    return this.envelope(workspaceId, {
      type: 'request.error',
      requestId,
      code,
      message
    });
  }
}

export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

function redactGitUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@]+@/, '//');
  }
}
