import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HybridSessionStore,
  createAgentHost,
  createLlmClientFromEnv,
  createLlmClientFromKrossConfig,
  getActiveKrossModelProfile,
  loadKrossConfig,
  type AgentRunInput,
  type AgentRunStreamEvent,
  type AgentResult,
  type SessionContextState,
  type SessionWorkStateV1,
  type StoredSession,
  type StoredSessionMessage
} from '@kross/core';

import {
  HEADLESS_SCHEMA_VERSION,
  headlessExitCodes,
  serializeHeadlessEvent,
  type HeadlessEvent,
  type HeadlessExecRequest,
  type HeadlessExitCode
} from './contract';

interface WritableText {
  write(text: string): unknown;
}

interface HeadlessRuntime {
  runStreaming(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent>;
  setPermissionMode(mode: HeadlessExecRequest['permission']): void;
  exportContextState(): SessionContextState;
  exportWorkState(): SessionWorkStateV1;
  restoreContextState(
    state: SessionContextState,
    options?: { preserveOpenTurn?: boolean }
  ): boolean;
  restoreWorkState(state: SessionWorkStateV1): boolean;
  restoreConversation(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): unknown;
  getPendingToolApproval(): AgentResult['pendingApproval'];
}

interface HeadlessHost {
  runtime: HeadlessRuntime;
  close(): Promise<void>;
}

interface HeadlessSessionStore {
  createSession(workspacePath: string): { id: string };
  loadSession(workspacePath: string, sessionId?: string): StoredSession | null;
  upsertMessage(
    sessionId: string,
    message: StoredSessionMessage
  ): unknown;
  upsertContextState(
    sessionId: string,
    state: SessionContextState,
    contextMessageId?: number
  ): unknown;
  upsertWorkState(sessionId: string, state: SessionWorkStateV1): unknown;
  close(): void;
}

interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface RunHeadlessDependencies {
  env?: Record<string, string | undefined>;
  processCwd?: string;
  stdout?: WritableText;
  stderr?: WritableText;
  now?: () => Date;
  createRunId?: () => string;
  readStdin?: () => Promise<string>;
  createHost?: (input: {
    cwd: string;
    env: Record<string, string | undefined>;
    runId: string;
  }) => Promise<HeadlessHost>;
  createSessionStore?: () => HeadlessSessionStore;
  signals?: SignalSource;
}

export async function runHeadlessCommand(
  request: HeadlessExecRequest,
  dependencies: RunHeadlessDependencies = {}
): Promise<HeadlessExitCode> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const now = dependencies.now ?? (() => new Date());
  const runId =
    dependencies.createRunId?.() ?? `run-${randomUUID()}`;
  const requestedCwd =
    request.cwd ?? dependencies.processCwd ?? process.cwd();
  const cwd = resolve(requestedCwd);
  const fallbackSessionId =
    request.sessionId ?? `session-${runId.slice(4)}`;
  let sessionId = fallbackSessionId;
  let sequence = 0;
  let host: HeadlessHost | undefined;
  let store: HeadlessSessionStore | undefined;
  let result: AgentResult | undefined;
  let lastMessageId: number | undefined;
  const abort = new AbortController();
  const onSignal = (): void => {
    abort.abort(new Error('Headless run interrupted by signal'));
  };
  const signals = dependencies.signals ?? process;
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);

  const emit = (
    type: HeadlessEvent['type'],
    data: HeadlessEvent['data']
  ): void => {
    const event = {
      schemaVersion: HEADLESS_SCHEMA_VERSION,
      type,
      timestamp: now().toISOString(),
      runId,
      sessionId,
      sequence,
      data
    } as HeadlessEvent;
    sequence += 1;
    stdout.write(serializeHeadlessEvent(event));
  };

  try {
    const task =
      request.input.source === 'stdin'
        ? await (dependencies.readStdin ?? readAllStdin)()
        : request.input.task;
    if (task.trim().length === 0) {
      emit('error', {
        category: 'usage',
        message: 'Headless task input is empty.',
        retryable: false
      });
      stderr.write('[kross:exec] Headless task input is empty.\n');
      return headlessExitCodes.usage;
    }
    try {
      if (!statSync(cwd).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new HeadlessConfigurationError(
        `Headless working directory does not exist: ${cwd}`
      );
    }

    host = await (
      dependencies.createHost ?? createDefaultHeadlessHost
    )({ cwd, env, runId });
    store = (dependencies.createSessionStore ?? createDefaultSessionStore)();
    const stored = request.sessionId
      ? store.loadSession(cwd, request.sessionId)
      : undefined;
    if (request.sessionId && !stored) {
      throw new HeadlessConfigurationError(
        `Session ${request.sessionId} does not exist in ${cwd}.`
      );
    }
    sessionId =
      stored?.summary.id ?? store.createSession(cwd).id;
    restoreStoredSession(host.runtime, stored);
    host.runtime.setPermissionMode(request.permission);
    const pending = host.runtime.getPendingToolApproval();
    if (pending) {
      emit('approval.required', {
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        risk: pending.risk,
        reason: pending.reason
      });
      persistRuntimeState(store, sessionId, host.runtime);
      return headlessExitCodes.approvalRequired;
    }

    lastMessageId = nextMessageId(stored);
    store.upsertMessage(sessionId, {
      id: lastMessageId,
      from: 'user',
      text: task,
      createdAt: now().toISOString()
    });
    emit('run.started', {
      mode: request.mode,
      permission: request.permission,
      cwd
    });

    for await (const event of host.runtime.runStreaming({
      input: task,
      requestedMode: request.mode,
      signal: abort.signal
    })) {
      if (event.type === 'turn-start') {
        emit('turn.started', { iteration: event.iteration });
      } else if (event.type === 'tools-start') {
        emit('tools.started', {
          iteration: event.iteration,
          count: event.count
        });
      } else if (event.type === 'text-delta') {
        emit('text.delta', { text: event.text });
      } else if (event.type === 'thinking-delta') {
        emit('thinking.delta', { text: event.text });
      } else {
        result = event.result;
      }
    }

    if (!result) {
      throw new Error('Headless Runtime finished without a result event.');
    }
    lastMessageId += 1;
    store.upsertMessage(sessionId, {
      id: lastMessageId,
      from: 'agent',
      text: result.summary,
      createdAt: now().toISOString(),
      verification: result.report.verification
    });
    persistRuntimeState(store, sessionId, host.runtime, lastMessageId);

    if (result.status === 'approval-required') {
      if (result.pendingApproval) {
        emit('approval.required', {
          toolCallId: result.pendingApproval.toolCallId,
          toolName: result.pendingApproval.toolName,
          risk: result.pendingApproval.risk,
          reason: result.pendingApproval.reason
        });
      } else {
        emit('error', {
          category: 'approval-required',
          message: 'The run stopped at an approval boundary.',
          retryable: false
        });
      }
      return headlessExitCodes.approvalRequired;
    }

    if (
      abort.signal.aborted ||
      result.cancellationReason === 'user-interrupt'
    ) {
      emit('error', {
        category: 'interrupted',
        message: result.summary || 'Headless run interrupted.',
        retryable: false
      });
      return headlessExitCodes.interrupted;
    }
    if (
      result.cancellationReason === 'approval-gate' ||
      result.cancellationReason === 'pending-approval'
    ) {
      emit('error', {
        category: 'approval-required',
        message: result.summary,
        retryable: false
      });
      return headlessExitCodes.approvalRequired;
    }

    emit('run.completed', {
      status: result.status,
      summary: result.summary,
      verificationStatus: result.report.verification.status,
      changedFiles: result.report.changedFiles,
      risks: result.report.risks
    });
    return exitCodeForResult(result, abort.signal.aborted);
  } catch (error) {
    const interrupted = abort.signal.aborted;
    const configuration = error instanceof HeadlessConfigurationError;
    const category = interrupted
      ? 'interrupted' as const
      : configuration
        ? 'configuration' as const
        : 'runtime' as const;
    const message =
      error instanceof Error ? error.message : String(error);
    emit('error', {
      category,
      message,
      retryable: false
    });
    stderr.write(`[kross:exec] ${message}\n`);
    if (store && host) {
      persistRuntimeState(
        store,
        sessionId,
        host.runtime,
        lastMessageId
      );
    }
    return interrupted
      ? headlessExitCodes.interrupted
      : configuration
        ? headlessExitCodes.configuration
        : headlessExitCodes.runtimeFailed;
  } finally {
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
    try {
      store?.close();
    } catch (error) {
      stderr.write(
        `[kross:exec] Session store close failed: ${errorMessage(error)}\n`
      );
    }
    try {
      await host?.close();
    } catch (error) {
      stderr.write(
        `[kross:exec] Runtime host close failed: ${errorMessage(error)}\n`
      );
    }
  }
}

async function createDefaultHeadlessHost(input: {
  cwd: string;
  env: Record<string, string | undefined>;
  runId: string;
}): Promise<HeadlessHost> {
  let configuredClient;
  try {
    const savedConfig = loadKrossConfig();
    configuredClient =
      createLlmClientFromEnv(
        input.env,
        undefined,
        getActiveKrossModelProfile(savedConfig)?.contextWindow
      ) ?? createLlmClientFromKrossConfig(savedConfig);
  } catch (error) {
    throw new HeadlessConfigurationError(
      `Model configuration is invalid: ${errorMessage(error)}`
    );
  }
  if (!configuredClient) {
    throw new HeadlessConfigurationError(
      'No model is configured. Set provider credentials or import a Kross model configuration before using exec.'
    );
  }

  const host = await createAgentHost({
    workspaceRoot: input.cwd,
    env: input.env
  });
  try {
    const runtime = host.createRuntime({
      createRunId: () => input.runId
    });
    return {
      runtime,
      close: () => host.close()
    };
  } catch (error) {
    await host.close();
    throw error;
  }
}

function createDefaultSessionStore(): HeadlessSessionStore {
  return new HybridSessionStore();
}

function restoreStoredSession(
  runtime: HeadlessRuntime,
  stored: StoredSession | null | undefined
): void {
  if (!stored) return;
  if (
    stored.contextState &&
    !runtime.restoreContextState(stored.contextState, {
      preserveOpenTurn: true
    })
  ) {
    throw new HeadlessConfigurationError(
      `Session ${stored.summary.id} has an invalid context checkpoint.`
    );
  }
  if (stored.workState && !runtime.restoreWorkState(stored.workState)) {
    throw new HeadlessConfigurationError(
      `Session ${stored.summary.id} has an invalid work checkpoint.`
    );
  }
  if (!stored.contextState) {
    const messages: Array<{
      role: 'user' | 'assistant';
      content: string;
    }> = [];
    for (const message of stored.messages) {
      if (message.from === 'user') {
        messages.push({ role: 'user', content: message.text });
      } else if (message.from === 'agent') {
        messages.push({ role: 'assistant', content: message.text });
      }
    }
    if (messages.length > 0) {
      runtime.restoreConversation(messages);
    }
  }
}

function persistRuntimeState(
  store: HeadlessSessionStore,
  sessionId: string,
  runtime: HeadlessRuntime,
  contextMessageId?: number
): void {
  store.upsertContextState(
    sessionId,
    runtime.exportContextState(),
    contextMessageId
  );
  store.upsertWorkState(sessionId, runtime.exportWorkState());
}

function nextMessageId(
  stored: StoredSession | null | undefined
): number {
  return (
    stored?.messages.reduce(
      (maximum, message) => Math.max(maximum, message.id),
      0
    ) ?? 0
  ) + 1;
}

function exitCodeForResult(
  result: AgentResult,
  interrupted: boolean
): HeadlessExitCode {
  if (interrupted || result.cancellationReason === 'user-interrupt') {
    return headlessExitCodes.interrupted;
  }
  if (
    result.cancellationReason === 'approval-gate' ||
    result.cancellationReason === 'pending-approval'
  ) {
    return headlessExitCodes.approvalRequired;
  }
  if (result.report.verification.status === 'failed') {
    return headlessExitCodes.verificationFailed;
  }
  if (result.status === 'failed' || result.status === 'cancelled') {
    return headlessExitCodes.runtimeFailed;
  }
  return headlessExitCodes.success;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HeadlessConfigurationError extends Error {}
