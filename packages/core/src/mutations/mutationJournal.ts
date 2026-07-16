import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

export type MutationToolName =
  | 'ApplyPatch'
  | 'Write'
  | 'Edit'
  | 'Delete'
  | 'Move';

export interface MutationEntrySnapshot {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  hash: string;
  contentRef?: string;
  linkTarget?: string;
}

export interface MutationRootSnapshot {
  path: string;
  hash: string;
  entries: MutationEntrySnapshot[];
}

export interface PreparedMutation {
  transactionId: string;
  runId: string;
  toolName: MutationToolName;
  workspaceRoot: string;
  createdAt: string;
  pre: MutationRootSnapshot[];
}

export interface MutationRecord extends PreparedMutation {
  post: MutationRootSnapshot[];
}

type MutationEvent =
  | { type: 'mutation.prepared'; mutation: PreparedMutation }
  | { type: 'mutation.committed'; transactionId: string; post: MutationRootSnapshot[] }
  | { type: 'mutation.rolled_back'; transactionId: string; reason: string }
  | { type: 'mutation.undone'; transactionId: string; undoneAt: string };

export class MutationJournal {
  readonly workspaceDir: string;
  readonly blobsDir: string;
  readonly journalPath: string;
  private readonly prepared = new Map<string, PreparedMutation>();
  private readonly committed = new Map<string, MutationRecord>();
  private readonly inactive = new Set<string>();

  constructor(
    readonly workspaceRoot: string,
    krossHome: string
  ) {
    const key = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24);
    this.workspaceDir = join(krossHome, 'mutations', key);
    this.blobsDir = join(this.workspaceDir, 'blobs');
    this.journalPath = join(this.workspaceDir, 'journal.jsonl');
    mkdirSync(this.blobsDir, { recursive: true });
    this.load();
  }

  createPrepared(input: {
    runId: string;
    toolName: MutationToolName;
    pre: MutationRootSnapshot[];
  }): PreparedMutation {
    return {
      transactionId: `mutation-${randomUUID()}`,
      runId: input.runId,
      toolName: input.toolName,
      workspaceRoot: this.workspaceRoot,
      createdAt: new Date().toISOString(),
      pre: input.pre
    };
  }

  appendPrepared(mutation: PreparedMutation): void {
    this.append({ type: 'mutation.prepared', mutation });
    this.prepared.set(mutation.transactionId, mutation);
  }

  appendCommitted(transactionId: string, post: MutationRootSnapshot[]): MutationRecord {
    const prepared = this.prepared.get(transactionId);
    if (!prepared) throw new Error(`Unknown prepared mutation: ${transactionId}`);
    this.append({ type: 'mutation.committed', transactionId, post });
    const record = { ...prepared, post };
    this.committed.set(transactionId, record);
    this.prepared.delete(transactionId);
    return record;
  }

  appendRolledBack(transactionId: string, reason: string): void {
    this.append({ type: 'mutation.rolled_back', transactionId, reason });
    this.prepared.delete(transactionId);
    this.inactive.add(transactionId);
  }

  appendUndone(transactionId: string): void {
    this.append({
      type: 'mutation.undone',
      transactionId,
      undoneAt: new Date().toISOString()
    });
    this.inactive.add(transactionId);
  }

  listActive(): MutationRecord[] {
    return [...this.committed.values()]
      .filter((item) => !this.inactive.has(item.transactionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listIncomplete(): PreparedMutation[] {
    return [...this.prepared.values()];
  }

  writeBlob(content: Buffer): string {
    const hash = createHash('sha256').update(content).digest('hex');
    const path = join(this.blobsDir, hash);
    if (!existsSync(path)) writeFileSync(path, content);
    return hash;
  }

  readBlob(ref: string): Buffer {
    return readFileSync(join(this.blobsDir, ref));
  }

  private append(event: MutationEvent): void {
    mkdirSync(this.workspaceDir, { recursive: true });
    appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  private load(): void {
    if (!existsSync(this.journalPath)) return;
    for (const line of readFileSync(this.journalPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as MutationEvent;
        if (event.type === 'mutation.prepared') {
          this.prepared.set(event.mutation.transactionId, event.mutation);
        } else if (event.type === 'mutation.committed') {
          const prepared = this.prepared.get(event.transactionId);
          if (prepared) {
            this.committed.set(event.transactionId, { ...prepared, post: event.post });
            this.prepared.delete(event.transactionId);
          }
        } else if (event.type === 'mutation.rolled_back') {
          this.prepared.delete(event.transactionId);
          this.inactive.add(event.transactionId);
        } else if (event.type === 'mutation.undone') {
          this.inactive.add(event.transactionId);
        }
      } catch {
        // A malformed tail must not hide earlier valid mutation history.
      }
    }
  }
}
