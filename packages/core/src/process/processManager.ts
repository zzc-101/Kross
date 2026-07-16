import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { resolveExistingPathWithinWorkspace } from '../tools/builtin/paths';
import { formatProcessCommandPreview } from './processCommandPreview';

export type ManagedProcessStatus = 'running' | 'exited' | 'killed';

export interface ProcessCursor {
  stdout: number;
  stderr: number;
}

export interface ProcessStartInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: 'pipe' | 'ignore';
  signal?: AbortSignal;
}

export interface ManagedProcessSummary {
  processId: string;
  command: string;
  cwd: string;
  status: ManagedProcessStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
}

export interface ProcessPollResult extends ManagedProcessSummary {
  stdout: string;
  stderr: string;
  cursor: ProcessCursor;
  truncated: { stdout: boolean; stderr: boolean };
}

export interface ProcessManagerOptions {
  maxBufferBytes?: number;
  maxPollBytes?: number;
  retentionMs?: number;
  termGraceMs?: number;
  now?: () => Date;
  createProcessId?: () => string;
  /** Tests may override platform-specific process-tree behavior. */
  platform?: NodeJS.Platform;
  killWindowsProcessTree?: (pid: number) => Promise<void>;
}

type SessionScope = string | typeof BOOTSTRAP_SESSION_SCOPE;

interface StreamBuffer {
  data: Buffer;
  start: number;
  end: number;
}

interface ManagedHandle {
  processId: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  stdinMode: 'pipe' | 'ignore';
  status: ManagedProcessStatus;
  startedAt: string;
  completedAt?: string;
  completedAtMs?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: StreamBuffer;
  stderr: StreamBuffer;
  sessionScope: SessionScope;
  terminationRequested: boolean;
}

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_MAX_POLL_BYTES = 64 * 1024;
const DEFAULT_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_TERM_GRACE_MS = 1000;
/** Explicit non-persisted scope used before a TUI session is selected. */
const BOOTSTRAP_SESSION_SCOPE = Symbol('bootstrap-process-session');

/** Session-scoped owner for background child processes and bounded output. */
export class ProcessManager {
  private readonly handles = new Map<string, ManagedHandle>();
  private readonly maxBufferBytes: number;
  private readonly maxPollBytes: number;
  private readonly retentionMs: number;
  private readonly termGraceMs: number;
  private readonly now: () => Date;
  private readonly createProcessId: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly killWindowsProcessTree: (pid: number) => Promise<void>;
  private activeSessionScope: SessionScope = BOOTSTRAP_SESSION_SCOPE;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    readonly workspaceRoot: string,
    options: ProcessManagerOptions = {}
  ) {
    this.maxBufferBytes = positive(options.maxBufferBytes, DEFAULT_MAX_BUFFER_BYTES);
    this.maxPollBytes = positive(options.maxPollBytes, DEFAULT_MAX_POLL_BYTES);
    this.retentionMs = positive(options.retentionMs, DEFAULT_RETENTION_MS);
    this.termGraceMs = positive(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
    this.now = options.now ?? (() => new Date());
    this.createProcessId =
      options.createProcessId ?? (() => `process-${randomUUID()}`);
    this.platform = options.platform ?? process.platform;
    this.killWindowsProcessTree =
      options.killWindowsProcessTree ?? runWindowsTaskkill;
  }

  /** Select the persisted agent session allowed to access process handles. */
  setSessionScope(sessionId?: string): void {
    this.activeSessionScope = sessionId?.trim() || BOOTSTRAP_SESSION_SCOPE;
  }

  async start(input: ProcessStartInput): Promise<ManagedProcessSummary> {
    if (this.closing) throw new Error('Process manager is closing');
    if (input.signal?.aborted) throw abortError(input.signal);
    const sessionScope = this.activeSessionScope;
    const command = input.command.trim();
    if (!command) throw new Error('Process command must not be empty');
    const cwd = await resolveExistingPathWithinWorkspace(
      this.workspaceRoot,
      input.cwd?.trim() || '.'
    );
    const env = mergeEnv(input.env);
    const stdinMode = input.stdin ?? 'pipe';
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      detached: this.platform !== 'win32',
      stdio: [stdinMode === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    const processId = this.createProcessId();
    const handle: ManagedHandle = {
      processId,
      command: formatProcessCommandPreview(command),
      cwd,
      child,
      stdinMode,
      status: 'running',
      startedAt: this.now().toISOString(),
      stdout: emptyBuffer(),
      stderr: emptyBuffer(),
      sessionScope,
      terminationRequested: false
    };
    this.handles.set(processId, handle);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      appendBounded(handle.stdout, chunk, this.maxBufferBytes);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      appendBounded(handle.stderr, chunk, this.maxBufferBytes);
    });
    child.once('close', (code, signal) => {
      if (handle.status === 'running') {
        handle.status = handle.terminationRequested || signal ? 'killed' : 'exited';
      }
      handle.exitCode = code ?? undefined;
      handle.signal = signal ?? undefined;
      const completed = this.now();
      handle.completedAt = completed.toISOString();
      handle.completedAtMs = completed.getTime();
    });

    try {
      await waitForSpawn(child, input.signal);
    } catch (error) {
      this.handles.delete(processId);
      signalChild(child, 'SIGKILL', this.platform);
      throw error;
    }
    return summarize(handle);
  }

  poll(
    processId: string,
    cursor: Partial<ProcessCursor> = {},
    maxBytes = this.maxPollBytes
  ): ProcessPollResult {
    this.gc();
    const handle = this.requireHandle(processId);
    let budget = Math.min(positive(maxBytes, this.maxPollBytes), this.maxPollBytes);
    const stdout = readBuffer(handle.stdout, cursor.stdout ?? 0, budget);
    budget -= stdout.bytes;
    const stderr = readBuffer(handle.stderr, cursor.stderr ?? 0, budget);
    return {
      ...summarize(handle),
      stdout: stdout.text,
      stderr: stderr.text,
      cursor: { stdout: stdout.cursor, stderr: stderr.cursor },
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated }
    };
  }

  async write(processId: string, text = '', eof = false): Promise<ManagedProcessSummary> {
    const handle = this.requireHandle(processId);
    if (handle.status !== 'running') {
      throw new Error(`Managed process is not running: ${processId}`);
    }
    if (handle.stdinMode !== 'pipe' || !handle.child.stdin) {
      throw new Error(`Managed process stdin is not piped: ${processId}`);
    }
    if (text.length > 0) {
      await new Promise<void>((resolve, reject) => {
        handle.child.stdin!.write(text, (error) =>
          error ? reject(error) : resolve()
        );
      });
    }
    if (eof) handle.child.stdin.end();
    return summarize(handle);
  }

  async kill(processId: string): Promise<ManagedProcessSummary> {
    const handle = this.requireHandle(processId);
    await this.terminate(handle);
    return summarize(handle);
  }

  list(): ManagedProcessSummary[] {
    this.gc();
    return [...this.handles.values()]
      .filter((handle) => handle.sessionScope === this.activeSessionScope)
      .map(summarize);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closing) return;
    this.closing = true;
    const attempt = Promise.all(
      [...this.handles.values()]
        .filter((handle) => handle.status === 'running')
        .map((handle) => this.terminate(handle))
    ).then(() => undefined);
    this.closePromise = attempt.catch((error) => {
      // A timed-out cleanup remains retryable instead of becoming a fake close.
      this.closing = false;
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private async terminate(handle: ManagedHandle): Promise<void> {
    if (handle.status !== 'running') return;
    handle.terminationRequested = true;
    const closed = waitForClose(handle.child);
    if (this.platform === 'win32' && handle.child.pid) {
      let treeKillFailed = false;
      try {
        await this.killWindowsProcessTree(handle.child.pid);
      } catch {
        treeKillFailed = true;
      }
      let didClose = await settlesWithin(closed, Math.max(250, this.termGraceMs));
      if (treeKillFailed || !didClose) {
        // taskkill can be unavailable in constrained shells; retain a fallback.
        signalChild(handle.child, 'SIGKILL', this.platform);
        didClose = await settlesWithin(closed, Math.max(250, this.termGraceMs));
      }
      if (!didClose) {
        handle.terminationRequested = false;
        throw new Error(`Managed process did not terminate: ${handle.processId}`);
      }
      return;
    }
    const termStartedAt = Date.now();
    signalChild(handle.child, 'SIGTERM', this.platform);
    const shellClosed = await settlesWithin(closed, this.termGraceMs);
    if (
      shellClosed &&
      isProcessGroupAlive(handle.child, this.platform)
    ) {
      const remainingGrace = this.termGraceMs - (Date.now() - termStartedAt);
      if (remainingGrace > 0) await delay(remainingGrace);
    }
    if (!shellClosed || isProcessGroupAlive(handle.child, this.platform)) {
      signalChild(handle.child, 'SIGKILL', this.platform);
      const didClose = await settlesWithin(closed, Math.max(250, this.termGraceMs));
      if (!didClose) {
        handle.terminationRequested = false;
        throw new Error(`Managed process did not terminate: ${handle.processId}`);
      }
    }
  }

  private requireHandle(processId: string): ManagedHandle {
    const handle = this.handles.get(processId);
    if (!handle || handle.sessionScope !== this.activeSessionScope) {
      throw new Error(`Unknown managed process: ${processId}`);
    }
    return handle;
  }

  private gc(): void {
    const cutoff = this.now().getTime() - this.retentionMs;
    for (const [id, handle] of this.handles) {
      if (handle.completedAtMs !== undefined && handle.completedAtMs < cutoff) {
        this.handles.delete(id);
      }
    }
  }
}

function emptyBuffer(): StreamBuffer {
  return { data: Buffer.alloc(0), start: 0, end: 0 };
}

function appendBounded(
  target: StreamBuffer,
  chunk: Buffer | string,
  maxBytes: number
): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  target.end += bytes.length;
  target.data = Buffer.concat([target.data, bytes]);
  if (target.data.length > maxBytes) {
    target.data = target.data.subarray(target.data.length - maxBytes);
  }
  target.start = target.end - target.data.length;
}

function readBuffer(
  source: StreamBuffer,
  requestedCursor: number,
  maxBytes: number
): { text: string; cursor: number; truncated: boolean; bytes: number } {
  const normalized = Math.max(0, Math.floor(requestedCursor));
  const cursor = Math.min(Math.max(normalized, source.start), source.end);
  const available = Math.max(0, source.end - cursor);
  const bytes = Math.min(available, Math.max(0, maxBytes));
  const offset = cursor - source.start;
  return {
    text: source.data.subarray(offset, offset + bytes).toString('utf8'),
    cursor: cursor + bytes,
    truncated: normalized < source.start,
    bytes
  };
}

function summarize(handle: ManagedHandle): ManagedProcessSummary {
  return {
    processId: handle.processId,
    command: handle.command,
    cwd: handle.cwd,
    status: handle.status,
    startedAt: handle.startedAt,
    completedAt: handle.completedAt,
    exitCode: handle.exitCode,
    signal: handle.signal
  };
}

function mergeEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!key || key.includes('=') || key.includes('\0') || value.includes('\0')) {
      throw new Error(`Invalid environment override key: ${key}`);
    }
    env[key] = value;
  }
  return env;
}

function waitForSpawn(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform
): void {
  try {
    if (platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
}

function isProcessGroupAlive(
  child: ChildProcess,
  platform: NodeJS.Platform
): boolean {
  if (platform === 'win32' || !child.pid) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Process start aborted');
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

function runWindowsTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'taskkill',
      buildWindowsTaskkillArgs(pid),
      { windowsHide: true },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

export function buildWindowsTaskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}
