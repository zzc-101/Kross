import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  isSessionContextState,
  type SessionContextState
} from '../context/sessionContext';
import {
  cloneSessionWorkState,
  isSessionWorkState,
  type SessionWorkStateV1
} from './sessionWorkState';

export type StoredSessionMessageFrom =
  | 'user'
  | 'agent'
  | 'system'
  | 'tool'
  | 'thinking';

/**
 * 会话日志保存的是 UI 可见记录。tool 由 TUI 自己解释，core 只保证它能被 JSON 序列化。
 */
export interface StoredSessionMessage {
  id: number;
  from: StoredSessionMessageFrom;
  text: string;
  createdAt?: string;
  durationMs?: number;
  expanded?: boolean;
  tool?: unknown;
  verification?: unknown;
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredSession {
  summary: SessionSummary;
  messages: StoredSessionMessage[];
  /** 治理后的模型上下文检查点；旧会话可能没有。 */
  contextState?: SessionContextState;
  /** Durable agent work state (todos/mode/pending plan), separate from model context. */
  workState?: SessionWorkStateV1;
}

export interface HybridSessionStoreOptions {
  krossHome?: string;
  now?: () => Date;
  createSessionId?: () => string;
}

interface SessionEvent {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  seq: number;
  type:
    | 'session.created'
    | 'session.renamed'
    | 'message.upserted'
    | 'context.updated'
    | 'work-state.updated';
  timestamp: string;
  payload: Record<string, unknown>;
}

interface SessionState {
  id: string;
  workspaceId: string;
  workspacePath: string;
  eventPath: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  explicitTitle?: string;
  messages: Map<number, { order: number; message: StoredSessionMessage }>;
  signatures: Map<number, string>;
  contextState?: SessionContextState;
  contextSignature?: string;
  /** 该检查点已覆盖到的最后一条 user/agent UI 消息。 */
  contextMessageId?: number;
  workState?: SessionWorkStateV1;
  workStateSignature?: string;
}

interface SessionRow {
  id: string;
  title: string;
  preview: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  event_path: string;
  event_size?: number;
}

interface SessionIndexStateRow {
  id: string;
  event_size: number;
}

const SESSION_SCHEMA_VERSION = 1;
const DEFAULT_SESSION_TITLE = '新会话';

/**
 * 产品级但刻意保持很薄的混合会话存储：
 * - events.jsonl 是唯一事实源，可追溯、可修复；
 * - SQLite 只投影最近会话元数据，删除后可从 JSONL 重建；
 * - 不引入 ORM，迁移和查询均为少量原生 SQL。
 */
export class HybridSessionStore {
  readonly krossHome: string;
  readonly sessionsRoot: string;
  readonly databasePath: string;

  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly createSessionId: () => string;
  private readonly states = new Map<string, SessionState>();

  constructor(options: HybridSessionStoreOptions = {}) {
    this.krossHome = options.krossHome ?? join(homedir(), '.kross');
    this.sessionsRoot = join(this.krossHome, 'sessions');
    this.databasePath = join(this.krossHome, 'session-store.db');
    this.now = options.now ?? (() => new Date());
    this.createSessionId =
      options.createSessionId ?? (() => `session-${randomUUID()}`);

    mkdirSync(this.sessionsRoot, { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createSession(workspacePath: string): SessionSummary {
    const canonicalPath = canonicalWorkspacePath(workspacePath);
    const workspaceId = createWorkspaceId(canonicalPath);
    const id = this.createSessionId();
    const eventPath = join(this.sessionsRoot, workspaceId, id, 'events.jsonl');
    const timestamp = this.now().toISOString();
    const state: SessionState = {
      id,
      workspaceId,
      workspacePath: canonicalPath,
      eventPath,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeq: 0,
      messages: new Map(),
      signatures: new Map()
    };

    mkdirSync(dirname(eventPath), { recursive: true });
    this.appendEvent(state, 'session.created', {
      workspaceId,
      workspacePath: canonicalPath
    });
    this.states.set(id, state);
    this.writeProjection(state);
    return toSummary(state);
  }

  renameSession(sessionId: string, title: string): SessionSummary | null {
    const state = this.getState(sessionId);
    const normalized = normalizeTitle(title);
    if (!state || normalized.length === 0) {
      return null;
    }
    if (state.explicitTitle !== normalized) {
      this.appendEvent(state, 'session.renamed', { title: normalized });
      state.explicitTitle = normalized;
      this.writeProjection(state);
    }
    return toSummary(state);
  }

  deleteSession(sessionId: string): boolean {
    const state = this.getState(sessionId);
    if (!state) return false;
    this.states.delete(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    rmSync(dirname(state.eventPath), { recursive: true, force: true });
    return true;
  }

  upsertMessage(
    sessionId: string,
    message: StoredSessionMessage
  ): SessionSummary | null {
    const state = this.getState(sessionId);
    if (!state || !isStoredSessionMessage(message)) {
      return null;
    }

    const normalized = cloneMessage(message);
    const signature = JSON.stringify(normalized);
    if (state.signatures.get(normalized.id) === signature) {
      return toSummary(state);
    }

    this.appendEvent(state, 'message.upserted', { message: normalized });
    const existing = state.messages.get(normalized.id);
    state.messages.set(normalized.id, {
      order: existing?.order ?? state.lastSeq,
      message: normalized
    });
    state.signatures.set(normalized.id, signature);
    this.writeProjection(state);
    return toSummary(state);
  }

  syncMessages(
    sessionId: string,
    messages: StoredSessionMessage[]
  ): SessionSummary | null {
    let summary: SessionSummary | null = null;
    for (const message of messages) {
      summary = this.upsertMessage(sessionId, message) ?? summary;
    }
    if (summary) {
      return summary;
    }
    const state = this.getState(sessionId);
    return state ? toSummary(state) : null;
  }

  upsertContextState(
    sessionId: string,
    contextState: SessionContextState,
    contextMessageId?: number
  ): SessionSummary | null {
    const state = this.getState(sessionId);
    if (!state || !isSessionContextState(contextState)) {
      return null;
    }
    const normalized = cloneContextState(contextState);
    const normalizedMessageId = normalizeMessageId(contextMessageId);
    const signature = JSON.stringify([normalized, normalizedMessageId]);
    if (state.contextSignature === signature) {
      return toSummary(state);
    }
    this.appendEvent(state, 'context.updated', {
      contextState: normalized,
      contextMessageId: normalizedMessageId
    });
    state.contextState = normalized;
    state.contextSignature = signature;
    state.contextMessageId = normalizedMessageId;
    this.writeProjection(state);
    return toSummary(state);
  }

  upsertWorkState(
    sessionId: string,
    workState: SessionWorkStateV1
  ): SessionSummary | null {
    const state = this.getState(sessionId);
    if (!state || !isSessionWorkState(workState)) {
      return null;
    }
    const normalized = cloneSessionWorkState(workState);
    const signature = JSON.stringify(normalized);
    if (state.workStateSignature === signature) {
      return toSummary(state);
    }
    this.appendEvent(state, 'work-state.updated', { workState: normalized });
    state.workState = normalized;
    state.workStateSignature = signature;
    this.writeProjection(state);
    return toSummary(state);
  }

  listRecent(workspacePath: string, limit = 5): SessionSummary[] {
    const canonicalPath = canonicalWorkspacePath(workspacePath);
    const workspaceId = createWorkspaceId(canonicalPath);
    this.repairWorkspace(canonicalPath, workspaceId);

    const rows = this.db
      .prepare(
        `SELECT id, title, preview, created_at, updated_at, message_count, event_path
         FROM sessions
         WHERE workspace_id = ? AND archived_at IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(workspaceId, Math.max(1, Math.floor(limit))) as SessionRow[];
    return rows.map(rowToSummary);
  }

  loadSession(
    workspacePath: string,
    selector?: string
  ): StoredSession | null {
    const canonicalPath = canonicalWorkspacePath(workspacePath);
    const workspaceId = createWorkspaceId(canonicalPath);
    this.repairWorkspace(canonicalPath, workspaceId);

    const row = selector?.trim()
      ? this.findSessionRow(workspaceId, selector.trim())
      : (this.db
          .prepare(
            `SELECT id, title, preview, created_at, updated_at, message_count, event_path
             FROM sessions
             WHERE workspace_id = ? AND archived_at IS NULL
             ORDER BY updated_at DESC, id DESC
             LIMIT 1`
          )
          .get(workspaceId) as SessionRow | undefined);
    if (!row) {
      return null;
    }

    const state = readStateFromFile(row.event_path);
    if (!state || state.workspaceId !== workspaceId) {
      return null;
    }
    this.states.set(state.id, state);
    this.writeProjection(state);
    return {
      summary: toSummary(state),
      messages: orderedMessages(state),
      contextState: isContextCheckpointCurrent(state)
        ? cloneContextState(state.contextState)
        : undefined,
      workState: state.workState
        ? cloneSessionWorkState(state.workState)
        : undefined
    };
  }

  private getState(sessionId: string): SessionState | undefined {
    const cached = this.states.get(sessionId);
    if (cached) {
      return cached;
    }
    const row = this.db
      .prepare(
        `SELECT id, title, preview, created_at, updated_at, message_count, event_path
         FROM sessions WHERE id = ? LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      return undefined;
    }
    const state = readStateFromFile(row.event_path);
    if (state) {
      this.states.set(state.id, state);
    }
    return state ?? undefined;
  }

  private findSessionRow(
    workspaceId: string,
    selector: string
  ): SessionRow | undefined {
    const exact = this.db
      .prepare(
        `SELECT id, title, preview, created_at, updated_at, message_count, event_path
         FROM sessions
         WHERE workspace_id = ? AND id = ? AND archived_at IS NULL
         LIMIT 1`
      )
      .get(workspaceId, selector) as SessionRow | undefined;
    if (exact) {
      return exact;
    }
    const prefixed = this.db
      .prepare(
        `SELECT id, title, preview, created_at, updated_at, message_count, event_path
         FROM sessions
         WHERE workspace_id = ? AND id LIKE ? ESCAPE '\\' AND archived_at IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT 2`
      )
      .all(workspaceId, `${escapeLike(selector)}%`) as SessionRow[];
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }

  private appendEvent(
    state: SessionState,
    type: SessionEvent['type'],
    payload: Record<string, unknown>
  ): void {
    const timestamp = this.now().toISOString();
    const event: SessionEvent = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      eventId: randomUUID(),
      sessionId: state.id,
      seq: state.lastSeq + 1,
      type,
      timestamp,
      payload
    };
    ensureTrailingNewline(state.eventPath);
    appendFileSync(state.eventPath, `${JSON.stringify(event)}\n`, 'utf8');
    state.lastSeq = event.seq;
    state.updatedAt = timestamp;
  }

  private writeProjection(state: SessionState): void {
    const summary = toSummary(state);
    this.db
      .prepare(
        `INSERT INTO sessions (
           id, workspace_id, workspace_path, title, preview, created_at,
           updated_at, last_seq, message_count, event_path, event_size, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           workspace_path = excluded.workspace_path,
           title = excluded.title,
           preview = excluded.preview,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           last_seq = excluded.last_seq,
           message_count = excluded.message_count,
           event_path = excluded.event_path,
           event_size = excluded.event_size`
      )
      .run(
        state.id,
        state.workspaceId,
        state.workspacePath,
        summary.title,
        summary.preview,
        state.createdAt,
        state.updatedAt,
        state.lastSeq,
        summary.messageCount,
        state.eventPath,
        statSync(state.eventPath).size
      );
  }

  private repairWorkspace(workspacePath: string, workspaceId: string): void {
    const workspaceRoot = join(this.sessionsRoot, workspaceId);
    if (!existsSync(workspaceRoot)) {
      return;
    }
    const indexed = new Map(
      (this.db
        .prepare('SELECT id, event_size FROM sessions WHERE workspace_id = ?')
        .all(workspaceId) as SessionIndexStateRow[])
        .map((row) => [row.id, row.event_size])
    );
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const eventPath = join(workspaceRoot, entry.name, 'events.jsonl');
      if (!existsSync(eventPath)) {
        continue;
      }
      const eventSize = statSync(eventPath).size;
      if (indexed.get(entry.name) === eventSize) {
        continue;
      }
      const state = readStateFromFile(eventPath);
      if (
        !state ||
        state.id !== entry.name ||
        state.workspacePath !== workspacePath
      ) {
        continue;
      }
      this.states.set(state.id, state);
      this.writeProjection(state);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .get() as { version: number } | undefined;
    if (!applied) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            title TEXT NOT NULL,
            preview TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_seq INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0,
            event_path TEXT NOT NULL,
            archived_at TEXT
          );
          CREATE INDEX IF NOT EXISTS sessions_workspace_recent_idx
            ON sessions(workspace_id, archived_at, updated_at DESC);
        `);
        this.db
          .prepare(
            'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)'
          )
          .run(1, this.now().toISOString());
      })();
    }

    const eventSizeMigration = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = 2')
      .get() as { version: number } | undefined;
    if (!eventSizeMigration) {
      this.db.transaction(() => {
        const columns = this.db.pragma('table_info(sessions)') as Array<{
          name: string;
        }>;
        if (!columns.some((column) => column.name === 'event_size')) {
          this.db.exec(
            'ALTER TABLE sessions ADD COLUMN event_size INTEGER NOT NULL DEFAULT 0'
          );
        }
        this.db
          .prepare(
            'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)'
          )
          .run(2, this.now().toISOString());
      })();
    }
  }
}

function readStateFromFile(eventPath: string): SessionState | null {
  if (!existsSync(eventPath)) {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(eventPath, 'utf8');
  } catch {
    return null;
  }

  let state: SessionState | undefined;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const event = parseEvent(line);
    if (!event) {
      // 崩溃可能留下半行；已有完整事件仍然可恢复。
      continue;
    }
    if (event.type === 'session.created') {
      const workspaceId = stringValue(event.payload.workspaceId);
      const workspacePath = stringValue(event.payload.workspacePath);
      if (!workspaceId || !workspacePath) {
        continue;
      }
      state = {
        id: event.sessionId,
        workspaceId,
        workspacePath,
        eventPath,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        lastSeq: event.seq,
        messages: new Map(),
        signatures: new Map()
      };
      continue;
    }
    if (!state || event.sessionId !== state.id || event.seq <= state.lastSeq) {
      continue;
    }
    state.lastSeq = event.seq;
    state.updatedAt = event.timestamp;
    if (event.type === 'session.renamed') {
      const title = stringValue(event.payload.title);
      if (title) {
        state.explicitTitle = normalizeTitle(title);
      }
      continue;
    }
    if (
      event.type === 'context.updated' &&
      isSessionContextState(event.payload.contextState)
    ) {
      state.contextState = cloneContextState(event.payload.contextState);
      state.contextMessageId = normalizeMessageId(
        event.payload.contextMessageId
      );
      state.contextSignature = JSON.stringify([
        state.contextState,
        state.contextMessageId
      ]);
      continue;
    }
    if (
      event.type === 'work-state.updated' &&
      isSessionWorkState(event.payload.workState)
    ) {
      state.workState = cloneSessionWorkState(event.payload.workState);
      state.workStateSignature = JSON.stringify(state.workState);
      continue;
    }
    const message = event.payload.message;
    if (event.type === 'message.upserted' && isStoredSessionMessage(message)) {
      const normalized = cloneMessage(message);
      const existing = state.messages.get(normalized.id);
      state.messages.set(normalized.id, {
        order: existing?.order ?? event.seq,
        message: normalized
      });
      state.signatures.set(normalized.id, JSON.stringify(normalized));
    }
  }
  return state ?? null;
}

function ensureTrailingNewline(eventPath: string): void {
  if (!existsSync(eventPath)) {
    return;
  }
  const size = statSync(eventPath).size;
  if (size === 0) {
    return;
  }
  const descriptor = openSync(eventPath, 'r');
  const lastByte = Buffer.allocUnsafe(1);
  try {
    readSync(descriptor, lastByte, 0, 1, size - 1);
  } finally {
    closeSync(descriptor);
  }
  if (lastByte[0] !== 0x0a) {
    appendFileSync(eventPath, '\n', 'utf8');
  }
}

function parseEvent(line: string): SessionEvent | null {
  try {
    const value = JSON.parse(line) as Partial<SessionEvent>;
    if (
      value.schemaVersion !== SESSION_SCHEMA_VERSION ||
      typeof value.eventId !== 'string' ||
      typeof value.sessionId !== 'string' ||
      !Number.isInteger(value.seq) ||
      (value.type !== 'session.created' &&
        value.type !== 'session.renamed' &&
        value.type !== 'message.upserted' &&
        value.type !== 'context.updated' &&
        value.type !== 'work-state.updated') ||
      typeof value.timestamp !== 'string' ||
      !value.payload ||
      typeof value.payload !== 'object'
    ) {
      return null;
    }
    return value as SessionEvent;
  } catch {
    return null;
  }
}

function isStoredSessionMessage(value: unknown): value is StoredSessionMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<StoredSessionMessage>;
  return (
    Number.isInteger(message.id) &&
    typeof message.id === 'number' &&
    message.id > 0 &&
    (message.from === 'user' ||
      message.from === 'agent' ||
      message.from === 'system' ||
      message.from === 'tool' ||
      message.from === 'thinking') &&
    typeof message.text === 'string'
  );
}

function cloneMessage(message: StoredSessionMessage): StoredSessionMessage {
  return JSON.parse(JSON.stringify(message)) as StoredSessionMessage;
}

function cloneContextState(state: SessionContextState): SessionContextState {
  return JSON.parse(JSON.stringify(state)) as SessionContextState;
}

function normalizeMessageId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function isContextCheckpointCurrent(state: SessionState): state is SessionState & {
  contextState: SessionContextState;
} {
  if (!state.contextState) {
    return false;
  }
  const latestDialogId = Math.max(
    0,
    ...orderedMessages(state)
      .filter((message) => message.from === 'user' || message.from === 'agent')
      .map((message) => message.id)
  );
  return (
    latestDialogId === 0 ||
    (state.contextMessageId !== undefined &&
      state.contextMessageId >= latestDialogId)
  );
}

function orderedMessages(state: SessionState): StoredSessionMessage[] {
  return [...state.messages.values()]
    .sort((left, right) => left.order - right.order)
    .map((entry) => cloneMessage(entry.message));
}

function toSummary(state: SessionState): SessionSummary {
  const messages = orderedMessages(state);
  return {
    id: state.id,
    title: state.explicitTitle ?? deriveTitle(messages),
    preview: derivePreview(messages),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    messageCount: messages.length
  };
}

function rowToSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    preview: row.preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count
  };
}

function deriveTitle(messages: StoredSessionMessage[]): string {
  const firstUser = messages.find((message) => message.from === 'user');
  if (!firstUser) {
    return DEFAULT_SESSION_TITLE;
  }
  const normalized = normalizeMessageText(firstUser.text);
  return normalized.length > 0 ? truncate(normalized, 56) : DEFAULT_SESSION_TITLE;
}

function derivePreview(messages: StoredSessionMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (message.from !== 'agent' && message.from !== 'user')) {
      continue;
    }
    const normalized = normalizeMessageText(message.text);
    if (normalized.length > 0) {
      return truncate(normalized, 96);
    }
  }
  return '';
}

function normalizeMessageText(value: string): string {
  return value.replace(/^>\s*/, '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value: string): string {
  return truncate(value.replace(/\s+/g, ' ').trim(), 80);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function canonicalWorkspacePath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function createWorkspaceId(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
