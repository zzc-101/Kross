import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { traceEventSchema, type TraceEvent } from '../domain';
import { isSafeRunId } from './runId';
import {
  buildTraceDetail,
  summarizeTraceEvents,
  type RunTraceDetail,
  type RunTraceSummary
} from './traceSummary';
import type { ListRunsOptions, TraceStore } from './traceStore';

const TRACE_SCHEMA_VERSION = 2;
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface SessionTraceStoreOptions {
  workspacePath: string;
  krossHome?: string;
  now?: () => Date;
  randomSuffix?: () => string;
}

interface TraceRunRow {
  run_id: string;
  workspace_key: string;
  file_path: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
}

/**
 * 按进程会话单文件落盘 trace，索引在 ~/.kross/traces/index.db。
 * 不再在项目目录创建 runs/；runId 仅存于 JSONL 行内字段。
 */
export class SessionTraceStore implements TraceStore {
  readonly krossHome: string;
  readonly tracesRoot: string;
  readonly workspaceKey: string;
  readonly workspaceDir: string;
  readonly sessionFilePath: string;
  readonly databasePath: string;

  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: SessionTraceStoreOptions) {
    this.krossHome = options.krossHome ?? join(homedir(), '.kross');
    this.tracesRoot = join(this.krossHome, 'traces');
    this.now = options.now ?? (() => new Date());
    const canonicalPath = canonicalWorkspacePath(options.workspacePath);
    this.workspaceKey = createWorkspaceKey(canonicalPath);
    this.workspaceDir = join(this.tracesRoot, this.workspaceKey);
    this.databasePath = join(this.tracesRoot, 'index.db');

    const suffix =
      options.randomSuffix?.() ??
      randomBytes(2).toString('hex');
    this.sessionFilePath = join(
      this.workspaceDir,
      createSessionFileName(this.now(), suffix)
    );

    mkdirSync(this.workspaceDir, { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.pruneExpiredTraces();
  }

  close(): void {
    this.db.close();
  }

  async append(event: TraceEvent): Promise<void> {
    const parsed = traceEventSchema.parse(event);
    if (!isSafeRunId(parsed.runId)) {
      throw new Error(`Unsafe runId: ${parsed.runId}`);
    }

    appendFileSync(this.sessionFilePath, `${JSON.stringify(parsed)}\n`, 'utf8');
    this.upsertRunIndex(parsed);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    if (!isSafeRunId(runId)) {
      return [];
    }

    const row = this.db
      .prepare(
        `SELECT run_id, workspace_key, file_path, first_seen, last_seen, event_count
         FROM trace_runs
         WHERE workspace_key = ? AND run_id = ?
         LIMIT 1`
      )
      .get(this.workspaceKey, runId) as TraceRunRow | undefined;

    if (row) {
      return readEventsFromFile(row.file_path, runId);
    }

    return readEventsFromFile(this.sessionFilePath, runId);
  }

  async listRunIds(): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT run_id
         FROM trace_runs
         WHERE workspace_key = ?
         ORDER BY last_seen DESC, run_id DESC`
      )
      .all(this.workspaceKey) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunTraceSummary[]> {
    const limit = options.limit ?? 10;
    const runIds = await this.listRunIds();
    const summaries: RunTraceSummary[] = [];

    for (const runId of runIds) {
      if (summaries.length >= limit) {
        break;
      }
      try {
        const events = await this.readRun(runId);
        const summary = summarizeTraceEvents(runId, events);
        if (summary) {
          summaries.push(summary);
        }
      } catch {
        // 单 run 失败不影响列表
      }
    }

    return summaries;
  }

  async inspectRun(runId: string): Promise<RunTraceDetail | null> {
    if (!isSafeRunId(runId)) {
      return null;
    }
    try {
      const events = await this.readRun(runId);
      return buildTraceDetail(runId, events);
    } catch {
      return null;
    }
  }

  private upsertRunIndex(event: TraceEvent): void {
    this.db
      .prepare(
        `INSERT INTO trace_runs (
           run_id, workspace_key, file_path, first_seen, last_seen, event_count
         ) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(workspace_key, run_id) DO UPDATE SET
           file_path = excluded.file_path,
           last_seen = excluded.last_seen,
           event_count = trace_runs.event_count + 1`
      )
      .run(
        event.runId,
        this.workspaceKey,
        this.sessionFilePath,
        event.timestamp,
        event.timestamp
      );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(TRACE_SCHEMA_VERSION) as { version: number } | undefined;
    if (applied) {
      return;
    }

    this.db.transaction(() => {
      // 先执行 DDL 取得 SQLite 写锁，再观察旧表。否则两个进程同时从 v1
      // 启动时，后进入事务的进程可能沿用锁外的过期判断并清空已迁移索引。
      this.db.exec(`
        DROP TABLE IF EXISTS trace_runs_v2;
        CREATE TABLE trace_runs_v2 (
          run_id TEXT NOT NULL,
          workspace_key TEXT NOT NULL,
          file_path TEXT NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          event_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_key, run_id)
        );
      `);
      const hasTraceRuns = this.db
        .prepare(
          `SELECT 1 AS present
           FROM sqlite_master
           WHERE type = 'table' AND name = 'trace_runs'`
        )
        .get() as { present: number } | undefined;
      if (hasTraceRuns) {
        this.db.exec(`
          INSERT OR REPLACE INTO trace_runs_v2 (
            run_id, workspace_key, file_path, first_seen, last_seen, event_count
          )
          SELECT run_id, workspace_key, file_path, first_seen, last_seen, event_count
          FROM trace_runs;
        `);
      }
      this.db.exec(`
        DROP TABLE IF EXISTS trace_runs;
        ALTER TABLE trace_runs_v2 RENAME TO trace_runs;
        CREATE INDEX IF NOT EXISTS trace_runs_workspace_recent_idx
          ON trace_runs(workspace_key, last_seen DESC);
      `);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
        )
        .run(TRACE_SCHEMA_VERSION, this.now().toISOString());
    })();
  }

  private pruneExpiredTraces(): void {
    try {
      const cutoff = this.now().getTime() - RETENTION_MS;
      this.pruneDirectory(this.tracesRoot, cutoff);
      for (const entry of readdirSync(this.tracesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        this.pruneDirectory(join(this.tracesRoot, entry.name), cutoff);
      }
    } catch {
      // best-effort 保留策略，失败静默
    }
  }

  private pruneDirectory(directory: string, cutoffMs: number): void {
    if (!existsSync(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const filePath = join(directory, entry.name);
      try {
        if (statSync(filePath).mtimeMs >= cutoffMs) {
          continue;
        }
        unlinkSync(filePath);
        this.db
          .prepare('DELETE FROM trace_runs WHERE file_path = ?')
          .run(filePath);
      } catch {
        // 单文件失败不影响其余清理
      }
    }
  }
}

function readEventsFromFile(filePath: string, runId: string): TraceEvent[] {
  if (!existsSync(filePath)) {
    return [];
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const events: TraceEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = traceEventSchema.parse(JSON.parse(line));
      if (parsed.runId === runId) {
        events.push(parsed);
      }
    } catch {
      // 跳过坏行，避免单行损坏拖垮整次 run 读取
    }
  }
  return events;
}

function createSessionFileName(now: Date, suffix: string): string {
  const timestamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  return `${timestamp}-${suffix}.jsonl`;
}

function canonicalWorkspacePath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function createWorkspaceKey(workspacePath: string): string {
  const hash = createHash('sha256')
    .update(workspacePath)
    .digest('hex')
    .slice(0, 8);
  const tail = sanitizePathSegment(basename(workspacePath));
  return `${tail}-${hash}`;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'workspace';
}

export function createWorkspaceKeyForTrace(workspacePath: string): string {
  return createWorkspaceKey(canonicalWorkspacePath(workspacePath));
}
