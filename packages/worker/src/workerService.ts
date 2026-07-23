import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import {
  AgentRuntime,
  bootstrapRuntimeTooling,
  createRuntimeOptionsFromEnv,
  HybridSessionStore,
  type AgentHostTooling,
  type AgentRunStreamEvent,
  type AgentMode,
  type StoredSessionMessage
} from '@kross/core';
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type EventEnvelope,
  type ServerEvent,
  type SessionSnapshot
} from '@kross/protocol';

import { EventJournal } from './eventJournal';
import { SessionSettingsStore } from './sessionSettingsStore';

const execFileAsync = promisify(execFile);

export interface WorkerServiceOptions {
  workspaceId: string;
  workspaceRoot: string;
  krossHome: string;
  env?: Record<string, string | undefined>;
  runtimeFactory?: () => Promise<RuntimeHandle>;
  now?: () => Date;
}

export interface RuntimeHandle {
  runtime: AgentRuntime;
  tooling: AgentHostTooling;
}

interface ActiveSession extends RuntimeHandle {
  id: string;
  nextMessageId: number;
  abortController?: AbortController;
  unsubscribeTrace: () => void;
  unsubscribeWorkState: () => void;
}

export type WorkerEventSink = (event: EventEnvelope) => void;

export class WorkerService {
  private readonly store: HybridSessionStore;
  private readonly journal: EventJournal;
  private readonly settings: SessionSettingsStore;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly sinks = new Set<WorkerEventSink>();
  private readonly now: () => Date;

  constructor(private readonly options: WorkerServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.store = new HybridSessionStore({ krossHome: options.krossHome });
    this.journal = new EventJournal(
      join(options.krossHome, 'cloud-events'),
      this.now
    );
    this.settings = new SessionSettingsStore(
      join(options.krossHome, 'cloud-session-settings')
    );
  }

  subscribe(sink: WorkerEventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  async handle(command: ClientCommand, sink?: WorkerEventSink): Promise<void> {
    if (
      'workspaceId' in command &&
      command.workspaceId !== this.options.workspaceId
    ) {
      this.emit(
        undefined,
        {
          type: 'request.error',
          requestId: command.requestId,
          code: 'WORKSPACE_MISMATCH',
          message: '命令不属于当前 worker 工作区'
        },
        sink
      );
      return;
    }
    const sessionId =
      'sessionId' in command && typeof command.sessionId === 'string'
        ? command.sessionId
        : undefined;
    if (sessionId && command.type !== 'session.resume') {
      const accepted = this.journal.findAcceptedRequest(
        this.options.workspaceId,
        sessionId,
        command.requestId
      );
      if (accepted) {
        sink?.(accepted);
        return;
      }
    }

    switch (command.type) {
      case 'session.create':
        await this.createSession(command.requestId, sink);
        return;
      case 'session.list':
        this.emit(
          undefined,
          {
            type: 'session.list',
            data: this.store.listRecent(
              this.options.workspaceRoot,
              command.limit ?? 20
            )
          },
          sink
        );
        return;
      case 'session.resume':
        await this.resumeSession(
          command.sessionId,
          command.lastSeq ?? 0,
          command.requestId,
          sink
        );
        return;
      case 'session.input':
        await this.runInput(
          command.sessionId,
          command.input,
          command.mode,
          command.planApproved === true,
          command.requestId,
          sink
        );
        return;
      case 'session.approval':
        await this.resolveApproval(
          command.sessionId,
          command.runId,
          command.approved,
          command.requestId,
          sink
        );
        return;
      case 'session.plan-approval':
        await this.resolvePlanApproval(command, sink);
        return;
      case 'session.abort':
        await this.abort(command.sessionId, command.requestId, sink);
        return;
      case 'session.settings':
        await this.updateSettings(command, sink);
        return;
      case 'session.inspect':
        await this.inspectSession(command, sink);
        return;
      case 'git.push':
      case 'git.pull-request':
        await this.runGitOperation(command, sink);
        return;
      default: {
        const sessionId =
          'sessionId' in command && typeof command.sessionId === 'string'
            ? command.sessionId
            : undefined;
        this.emit(
          sessionId,
          {
            type: 'request.error',
            requestId: command.requestId,
            code: 'UNSUPPORTED_COMMAND',
            message: `worker 不支持 ${command.type}`
          },
          sink
        );
      }
    }
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.abortController?.abort('worker shutdown');
      session.unsubscribeTrace();
      session.unsubscribeWorkState();
      await session.tooling.close();
    }
    this.sessions.clear();
    this.store.close();
  }

  private async createSession(
    requestId: string,
    sink?: WorkerEventSink
  ): Promise<void> {
    const summary = this.store.createSession(this.options.workspaceRoot);
    const session = await this.loadRuntime(summary.id);
    this.emit(summary.id, { type: 'request.accepted', requestId }, sink);
    this.emit(
      summary.id,
      { type: 'session.snapshot', data: this.snapshot(session, summary, []) },
      sink
    );
  }

  private async resumeSession(
    sessionId: string,
    lastSeq: number,
    requestId: string,
    sink?: WorkerEventSink
  ): Promise<void> {
    const stored = this.store.loadSession(this.options.workspaceRoot, sessionId);
    if (!stored) {
      this.emitError(sessionId, requestId, 'SESSION_NOT_FOUND', '会话不存在', sink);
      return;
    }
    const replay = this.journal.replay(
      this.options.workspaceId,
      sessionId,
      lastSeq
    );
    for (const event of replay) sink?.(event);
    const session = await this.loadRuntime(sessionId, stored);
    this.emit(
      sessionId,
      {
        type: 'session.snapshot',
        data: this.snapshot(session, stored.summary, stored.messages)
      },
      sink
    );
    this.emit(
      sessionId,
      {
        type: 'replay.complete',
        fromSeq: lastSeq,
        toSeq: this.journal.lastSeq(this.options.workspaceId, sessionId)
      },
      sink
    );
    this.emit(sessionId, { type: 'request.accepted', requestId }, sink);
  }

  private async runInput(
    sessionId: string,
    input: string,
    mode: AgentMode,
    planApproved: boolean,
    requestId: string,
    sink?: WorkerEventSink
  ): Promise<void> {
    const session = await this.requireSession(sessionId, requestId, sink);
    if (!session) return;
    if (session.abortController) {
      this.emitError(sessionId, requestId, 'SESSION_BUSY', '会话正在运行', sink);
      return;
    }
    this.emit(sessionId, { type: 'request.accepted', requestId }, sink);
    if (!planApproved) {
      this.persistMessage(session, 'user', input);
    }
    const controller = new AbortController();
    session.abortController = controller;
    try {
      await this.consumeStream(
        session,
        session.runtime.runStreaming({
          input,
          requestedMode: mode,
          approvals: { plan: planApproved },
          signal: controller.signal
        }),
        sink
      );
    } catch (error) {
      this.emitError(
        sessionId,
        requestId,
        'RUN_FAILED',
        error instanceof Error ? error.message : String(error),
        sink
      );
    } finally {
      session.abortController = undefined;
      this.persistState(session);
    }
  }

  private async resolveApproval(
    sessionId: string,
    runId: string,
    approved: boolean,
    requestId: string,
    sink?: WorkerEventSink
  ): Promise<void> {
    const session = await this.requireSession(sessionId, requestId, sink);
    if (!session) return;
    if (session.abortController) {
      this.emitError(sessionId, requestId, 'SESSION_BUSY', '会话正在运行', sink);
      return;
    }
    this.emit(sessionId, { type: 'request.accepted', requestId }, sink);
    const controller = new AbortController();
    session.abortController = controller;
    try {
      await this.consumeStream(
        session,
        session.runtime.resolveToolApprovalStreaming({
          runId,
          approved,
          signal: controller.signal
        }),
        sink
      );
    } finally {
      session.abortController = undefined;
      this.persistState(session);
    }
  }

  private async resolvePlanApproval(
    command: Extract<ClientCommand, { type: 'session.plan-approval' }>,
    sink?: WorkerEventSink
  ): Promise<void> {
    const session = await this.requireSession(
      command.sessionId,
      command.requestId,
      sink
    );
    if (!session) return;
    const pending = session.runtime.getPendingModeExecution();
    if (!pending) {
      this.emitError(
        command.sessionId,
        command.requestId,
        'PLAN_NOT_PENDING',
        '当前没有等待确认的计划',
        sink
      );
      return;
    }
    if (command.approved) {
      if (!command.input) {
        this.emitError(
          command.sessionId,
          command.requestId,
          'PLAN_INPUT_REQUIRED',
          '批准计划时必须提供原始任务输入',
          sink
        );
        return;
      }
      await this.runInput(
        command.sessionId,
        command.input,
        pending.kind === 'conductor' ? 'conductor' : 'plan',
        true,
        command.requestId,
        sink
      );
      return;
    }
    session.runtime.clearPendingModeExecution();
    this.persistState(session);
    this.emit(
      command.sessionId,
      { type: 'request.accepted', requestId: command.requestId },
      sink
    );
    const stored = this.store.loadSession(
      this.options.workspaceRoot,
      command.sessionId
    );
    if (stored) {
      this.emit(
        command.sessionId,
        {
          type: 'session.snapshot',
          data: this.snapshot(session, stored.summary, stored.messages)
        },
        sink
      );
    }
  }

  private async abort(
    sessionId: string,
    requestId: string,
    sink?: WorkerEventSink
  ): Promise<void> {
    const session = await this.requireSession(sessionId, requestId, sink);
    if (!session) return;
    session.abortController?.abort('remote user abort');
    const approval = session.runtime.getPendingToolApproval();
    if (approval) {
      await session.runtime.interruptPendingToolApproval(
        approval.runId,
        '远程用户取消'
      );
    }
    this.persistState(session);
    this.emit(sessionId, { type: 'request.accepted', requestId }, sink);
  }

  private async updateSettings(
    command: Extract<ClientCommand, { type: 'session.settings' }>,
    sink?: WorkerEventSink
  ): Promise<void> {
    const session = await this.requireSession(
      command.sessionId,
      command.requestId,
      sink
    );
    if (!session) return;
    try {
      if (command.model) session.runtime.setModel(command.model);
      if (command.thinkingEffort) {
        session.runtime.setThinkingEffort(command.thinkingEffort);
      }
      if (command.model || command.thinkingEffort) {
        this.settings.update(command.sessionId, {
          ...(command.model ? { model: command.model } : {}),
          ...(command.thinkingEffort
            ? { thinkingEffort: command.thinkingEffort }
            : {})
        });
      }
      if (command.mode) {
        session.runtime.setSessionMode(command.mode);
        this.persistState(session);
      }
      this.emit(
        command.sessionId,
        { type: 'request.accepted', requestId: command.requestId },
        sink
      );
      const stored = this.store.loadSession(
        this.options.workspaceRoot,
        command.sessionId
      );
      if (stored) {
        this.emit(
          command.sessionId,
          {
            type: 'session.snapshot',
            data: this.snapshot(session, stored.summary, stored.messages)
          },
          sink
        );
      }
    } catch (error) {
      this.emitError(
        command.sessionId,
        command.requestId,
        'SETTINGS_FAILED',
        error instanceof Error ? error.message : String(error),
        sink
      );
    }
  }

  private async inspectSession(
    command: Extract<ClientCommand, { type: 'session.inspect' }>,
    sink?: WorkerEventSink
  ): Promise<void> {
    const session = await this.requireSession(
      command.sessionId,
      command.requestId,
      sink
    );
    if (!session) return;
    try {
      const content =
        command.kind === 'diff'
          ? await session.runtime.formatDiffCommand(command.argument)
          : await session.runtime.formatTraceCommand(command.argument);
      this.emit(
        command.sessionId,
        {
          type: 'inspection.result',
          data: { kind: command.kind, content }
        },
        sink
      );
      this.emit(
        command.sessionId,
        { type: 'request.accepted', requestId: command.requestId },
        sink
      );
    } catch (error) {
      this.emitError(
        command.sessionId,
        command.requestId,
        'INSPECTION_FAILED',
        error instanceof Error ? error.message : String(error),
        sink
      );
    }
  }

  private async runGitOperation(
    command: Extract<ClientCommand, { type: 'git.push' | 'git.pull-request' }>,
    sink?: WorkerEventSink
  ): Promise<void> {
    const session = await this.requireSession(
      command.sessionId,
      command.requestId,
      sink
    );
    if (!session) return;
    try {
      if (command.type === 'git.push') {
        const args = [
          'push',
          ...(command.setUpstream ? ['--set-upstream'] : []),
          command.remote,
          command.branch
        ];
        const result = await execFileAsync('git', args, {
          cwd: this.options.workspaceRoot,
          env: this.gitEnvironment(),
          maxBuffer: 4 * 1024 * 1024
        });
        this.emit(command.sessionId, {
          type: 'git.result',
          data: {
            operation: 'push',
            ok: true,
            output: `${result.stdout}${result.stderr}`.trim()
          }
        }, sink);
      } else {
        const result = await execFileAsync(
          'gh',
          [
            'pr',
            'create',
            '--title',
            command.title,
            '--body',
            command.body,
            '--base',
            command.base,
            '--head',
            command.head
          ],
          {
            cwd: this.options.workspaceRoot,
            env: this.gitEnvironment(true),
            maxBuffer: 4 * 1024 * 1024
          }
        );
        const output = `${result.stdout}${result.stderr}`.trim();
        const url = output.match(/https:\/\/\S+/)?.[0];
        this.emit(command.sessionId, {
          type: 'git.result',
          data: { operation: 'pull-request', ok: true, output, url }
        }, sink);
      }
      this.emit(
        command.sessionId,
        { type: 'request.accepted', requestId: command.requestId },
        sink
      );
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      this.emit(command.sessionId, {
        type: 'git.result',
        data: {
          operation: command.type === 'git.push' ? 'push' : 'pull-request',
          ok: false,
          output:
            `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() ||
            failure.message
        }
      }, sink);
      this.emitError(
        command.sessionId,
        command.requestId,
        'GIT_OPERATION_FAILED',
        failure.message,
        sink
      );
    }
  }

  private gitEnvironment(requireGitHubToken = false): NodeJS.ProcessEnv {
    const credentialRoot = join(this.options.krossHome);
    const tokenPath = join(credentialRoot, 'git-token');
    const askpassPath = join(credentialRoot, 'git-askpass.sh');
    const sshKeyPath = join(credentialRoot, 'ssh', 'id_ed25519');
    const knownHostsPath = join(credentialRoot, 'ssh', 'known_hosts');
    const token = existsSync(tokenPath)
      ? readFileSync(tokenPath, 'utf8').trim()
      : undefined;
    if (requireGitHubToken && !token && !process.env.GH_TOKEN) {
      throw new Error('创建 PR 需要 HTTPS Git token 或容器内 GH_TOKEN');
    }
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(existsSync(askpassPath) ? { GIT_ASKPASS: askpassPath } : {}),
      ...(existsSync(sshKeyPath)
        ? {
            GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o UserKnownHostsFile=${knownHostsPath} -o StrictHostKeyChecking=accept-new`
          }
        : {}),
      ...(token ? { GH_TOKEN: token } : {})
    };
  }

  private async consumeStream(
    session: ActiveSession,
    stream: AsyncIterable<AgentRunStreamEvent>,
    sink?: WorkerEventSink
  ): Promise<void> {
    let text = '';
    let thinking = '';
    let finalResult: Extract<AgentRunStreamEvent, { type: 'result' }>['result'] | undefined;
    for await (const data of stream) {
      this.emit(session.id, { type: 'stream', data }, sink);
      if (data.type === 'text-delta') text += data.text;
      if (data.type === 'thinking-delta') thinking += data.text;
      if (data.type === 'result') {
        finalResult = data.result;
        if (data.result.pendingApproval) {
          this.emit(
            session.id,
            { type: 'approval.pending', data: data.result.pendingApproval },
            sink
          );
        }
      }
    }
    if (thinking) this.persistMessage(session, 'thinking', thinking);
    if (text) this.persistMessage(session, 'agent', text);
    if (!text && finalResult?.summary.trim()) {
      this.persistMessage(
        session,
        finalResult.status === 'approval-required' ? 'system' : 'agent',
        finalResult.summary
      );
    }
    this.persistState(session);
    const stored = this.store.loadSession(
      this.options.workspaceRoot,
      session.id
    );
    if (stored) {
      this.emit(
        session.id,
        {
          type: 'session.snapshot',
          data: this.snapshot(session, stored.summary, stored.messages)
        },
        sink
      );
    }
  }

  private async requireSession(
    sessionId: string,
    requestId: string,
    sink?: WorkerEventSink
  ): Promise<ActiveSession | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const stored = this.store.loadSession(this.options.workspaceRoot, sessionId);
    if (!stored) {
      this.emitError(sessionId, requestId, 'SESSION_NOT_FOUND', '会话不存在', sink);
      return undefined;
    }
    return this.loadRuntime(sessionId, stored);
  }

  private async loadRuntime(
    sessionId: string,
    stored = this.store.loadSession(this.options.workspaceRoot, sessionId) ??
      undefined
  ): Promise<ActiveSession> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const handle = this.options.runtimeFactory
      ? await this.options.runtimeFactory()
      : await this.createDefaultRuntime();
    if (stored?.contextState) {
      handle.runtime.restoreContextState(stored.contextState, {
        preserveOpenTurn: stored.workState?.runCheckpoint?.status ===
          'awaiting-approval'
      });
    } else if (stored) {
      handle.runtime.restoreConversation(
        stored.messages
          .filter((message) => message.from === 'user' || message.from === 'agent')
          .map((message) => ({
            role: message.from === 'user' ? 'user' as const : 'assistant' as const,
            content: message.text
          }))
      );
    }
    if (stored?.workState) handle.runtime.restoreWorkState(stored.workState);
    const settings = this.settings.load(sessionId);
    if (settings.model) {
      try {
        handle.runtime.setModel(settings.model);
      } catch {
        // Provider changed since the session was saved; retain its current default.
      }
    }
    if (settings.thinkingEffort) {
      try {
        handle.runtime.setThinkingEffort(settings.thinkingEffort);
      } catch {
        // Provider may no longer support configurable reasoning effort.
      }
    }
    handle.runtime.setManagedProcessSession(sessionId);
    const active: ActiveSession = {
      ...handle,
      id: sessionId,
      nextMessageId:
        Math.max(0, ...(stored?.messages.map((message) => message.id) ?? [])) + 1,
      unsubscribeTrace: () => undefined,
      unsubscribeWorkState: () => undefined
    };
    active.unsubscribeTrace = handle.tooling.traceStore.subscribe((trace) => {
      this.emit(sessionId, { type: 'trace', data: trace });
    });
    active.unsubscribeWorkState = handle.runtime.onWorkStateChanged(() => {
      this.persistState(active);
      this.emit(sessionId, {
        type: 'todo.snapshot',
        data: handle.runtime.getTodoStore()?.list() ?? []
      });
    });
    this.sessions.set(sessionId, active);
    return active;
  }

  private async createDefaultRuntime(): Promise<RuntimeHandle> {
    const tooling = await bootstrapRuntimeTooling(
      this.options.workspaceRoot,
      this.options.env ?? process.env,
      {
        homeDir: this.options.krossHome,
        krossHome: this.options.krossHome
      }
    );
    const runtime = new AgentRuntime(
      createRuntimeOptionsFromEnv(
        this.options.workspaceRoot,
        this.options.env ?? process.env,
        undefined,
        {
          homeDir: this.options.krossHome,
          krossHome: this.options.krossHome
        },
        tooling
      )
    );
    return { runtime, tooling };
  }

  private snapshot(
    session: ActiveSession,
    summary: SessionSnapshot['summary'],
    messages: StoredSessionMessage[]
  ): SessionSnapshot {
    return {
      summary,
      messages,
      pendingApproval: session.runtime.getPendingToolApproval(),
      pendingPlan: session.runtime.getPendingModeExecution(),
      todos: session.runtime.getTodoStore()?.list() ?? [],
      mode: session.runtime.getSessionMode(),
      model: session.runtime.getLlmClient()?.model,
      thinkingEffort: session.runtime.getThinkingEffort()
    };
  }

  private persistMessage(
    session: ActiveSession,
    from: StoredSessionMessage['from'],
    text: string
  ): void {
    this.store.upsertMessage(session.id, {
      id: session.nextMessageId++,
      from,
      text,
      createdAt: this.now().toISOString()
    });
  }

  private persistState(session: ActiveSession): void {
    this.store.upsertContextState(
      session.id,
      session.runtime.exportContextState(),
      session.nextMessageId - 1
    );
    this.store.upsertWorkState(session.id, session.runtime.exportWorkState());
  }

  private emit(
    sessionId: string | undefined,
    event: ServerEvent,
    sink?: WorkerEventSink
  ): EventEnvelope {
    const envelope = this.journal.append(
      this.options.workspaceId,
      sessionId,
      event
    );
    sink?.(envelope);
    for (const subscriber of this.sinks) {
      if (subscriber !== sink) subscriber(envelope);
    }
    return envelope;
  }

  private emitError(
    sessionId: string | undefined,
    requestId: string,
    code: string,
    message: string,
    sink?: WorkerEventSink
  ): void {
    this.emit(
      sessionId,
      { type: 'request.error', requestId, code, message },
      sink
    );
  }
}

export function createWorkerCommand(
  command: Omit<ClientCommand, 'protocolVersion'>
): ClientCommand {
  return { ...command, protocolVersion: PROTOCOL_VERSION } as ClientCommand;
}
