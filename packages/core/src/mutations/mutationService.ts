import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { resolveWritablePathWithinWorkspace } from '../tools/builtin/paths';
import {
  MutationJournal,
  type MutationEntrySnapshot,
  type MutationRecord,
  type MutationRootSnapshot,
  type MutationToolName
} from './mutationJournal';

export interface UndoResult {
  transactions: string[];
  files: string[];
}

export class MutationConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`Cannot undo because files changed after the mutation: ${paths.join(', ')}`);
    this.name = 'MutationConflictError';
  }
}

export class MutationService {
  readonly workspaceRoot: string;
  readonly journal: MutationJournal;

  constructor(workspaceRoot: string, krossHome: string) {
    this.workspaceRoot = existsSync(workspaceRoot)
      ? realpathSync(workspaceRoot)
      : resolve(workspaceRoot);
    this.journal = new MutationJournal(this.workspaceRoot, krossHome);
    this.recoverIncomplete();
  }

  async record<T>(input: {
    runId: string;
    toolName: MutationToolName;
    paths: string[];
    action: () => Promise<T>;
  }): Promise<T> {
    const paths = uniqueRoots(input.paths);
    await Promise.all(
      paths.map((path) => resolveWritablePathWithinWorkspace(this.workspaceRoot, path))
    );
    const pre = paths.map((path) => this.captureRoot(path));
    const prepared = this.journal.createPrepared({
      runId: input.runId,
      toolName: input.toolName,
      pre
    });
    this.journal.appendPrepared(prepared);
    try {
      const result = await input.action();
      const post = paths.map((path) => this.captureRoot(path));
      if (sameRoots(pre, post)) {
        this.journal.appendRolledBack(prepared.transactionId, 'no-change');
      } else {
        this.journal.appendCommitted(prepared.transactionId, post);
      }
      return result;
    } catch (error) {
      this.restoreRoots(pre);
      this.journal.appendRolledBack(
        prepared.transactionId,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  listActive(): MutationRecord[] {
    return this.journal.listActive();
  }

  undo(target?: string): UndoResult {
    const selected = this.select(target);
    if (selected.length === 0) {
      throw new Error(target ? `No reversible mutation found: ${target}` : 'No reversible mutations');
    }
    const ordered = [...selected].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.assertCanUndo(target);

    const restored: string[] = [];
    for (const transaction of ordered) {
      this.restoreRoots(transaction.pre);
      this.journal.appendUndone(transaction.transactionId);
      restored.push(...transaction.pre.map((item) => item.path));
    }
    return {
      transactions: ordered.map((item) => item.transactionId),
      files: [...new Set(restored)]
    };
  }

  assertCanUndo(target?: string): void {
    const conflicts: string[] = [];
    for (const transaction of this.select(target)) {
      for (const post of transaction.post) {
        if (this.captureRoot(post.path).hash !== post.hash) conflicts.push(post.path);
      }
    }
    if (conflicts.length > 0) throw new MutationConflictError([...new Set(conflicts)]);
  }

  private select(target?: string): MutationRecord[] {
    const active = this.journal.listActive();
    return target
      ? active.filter(
          (item) => item.runId === target || item.transactionId === target
        )
      : active.length > 0
        ? [active[active.length - 1]!]
        : [];
  }

  private captureRoot(inputPath: string): MutationRootSnapshot {
    const absolute = resolve(this.workspaceRoot, inputPath);
    const relativeRoot = normalizeRelative(this.workspaceRoot, absolute);
    const entries: MutationEntrySnapshot[] = [];
    if (existsSync(absolute)) this.captureEntry(absolute, entries);
    return {
      path: relativeRoot,
      entries,
      hash: hashEntries(entries)
    };
  }

  private captureEntry(absolute: string, entries: MutationEntrySnapshot[]): void {
    const meta = lstatSync(absolute);
    const path = normalizeRelative(this.workspaceRoot, absolute);
    if (meta.isSymbolicLink()) {
      const linkTarget = readlinkSync(absolute);
      entries.push({
        path,
        kind: 'symlink',
        linkTarget,
        hash: sha(Buffer.from(linkTarget))
      });
      return;
    }
    if (meta.isDirectory()) {
      entries.push({ path, kind: 'directory', hash: 'directory' });
      for (const child of readdirSync(absolute).sort()) {
        this.captureEntry(join(absolute, child), entries);
      }
      return;
    }
    const content = readFileSync(absolute);
    const contentRef = this.journal.writeBlob(content);
    entries.push({ path, kind: 'file', contentRef, hash: sha(content) });
  }

  private restoreRoots(roots: MutationRootSnapshot[]): void {
    for (const root of roots) {
      const absoluteRoot = resolve(this.workspaceRoot, root.path);
      assertLexical(this.workspaceRoot, absoluteRoot);
      rmSync(absoluteRoot, { recursive: true, force: true });
      const directories = root.entries.filter((entry) => entry.kind === 'directory');
      for (const entry of directories) {
        const path = resolve(this.workspaceRoot, entry.path);
        assertLexical(this.workspaceRoot, path);
        mkdirSync(path, { recursive: true });
      }
      for (const entry of root.entries.filter((item) => item.kind !== 'directory')) {
        const path = resolve(this.workspaceRoot, entry.path);
        assertLexical(this.workspaceRoot, path);
        mkdirSync(dirname(path), { recursive: true });
        if (entry.kind === 'file' && entry.contentRef) {
          writeFileSync(path, this.journal.readBlob(entry.contentRef));
        } else if (entry.kind === 'symlink' && entry.linkTarget !== undefined) {
          symlinkSync(entry.linkTarget, path);
        }
      }
    }
  }

  private recoverIncomplete(): void {
    for (const mutation of this.journal.listIncomplete()) {
      this.restoreRoots(mutation.pre);
      this.journal.appendRolledBack(mutation.transactionId, 'recovered-incomplete');
    }
  }
}

export class MutationCoordinator {
  private readonly services = new Map<string, MutationService>();

  constructor(private readonly krossHome: string) {}

  forWorkspace(workspaceRoot: string): MutationService {
    const canonical = existsSync(workspaceRoot)
      ? realpathSync(workspaceRoot)
      : resolve(workspaceRoot);
    let service = this.services.get(canonical);
    if (!service) {
      service = new MutationService(canonical, this.krossHome);
      this.services.set(canonical, service);
    }
    return service;
  }

  undo(target?: string): UndoResult {
    const candidates = [...this.services.values()].flatMap((service) =>
      service.listActive().map((record) => ({ service, record }))
    );
    const matching = target
      ? candidates.filter(
          ({ record }) => record.runId === target || record.transactionId === target
        )
      : candidates.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt)).slice(-1);
    if (matching.length === 0) throw new Error('No reversible mutations');
    if (target) {
      const byService = new Map<MutationService, string>();
      for (const item of matching) byService.set(item.service, target);
      for (const [service, selector] of byService) {
        service.assertCanUndo(selector);
      }
      const results = [...byService].map(([service, selector]) => service.undo(selector));
      return mergeUndoResults(results);
    }
    return matching[0]!.service.undo(matching[0]!.record.transactionId);
  }
}

function mergeUndoResults(results: UndoResult[]): UndoResult {
  return {
    transactions: results.flatMap((item) => item.transactions),
    files: [...new Set(results.flatMap((item) => item.files))]
  };
}

function uniqueRoots(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.replace(/\\/g, '/')))];
}

function hashEntries(entries: MutationEntrySnapshot[]): string {
  return sha(Buffer.from(JSON.stringify(entries.map(({ contentRef, ...entry }) => ({ ...entry, contentRef })) )));
}

function sameRoots(a: MutationRootSnapshot[], b: MutationRootSnapshot[]): boolean {
  return a.length === b.length && a.every((item, index) => item.path === b[index]?.path && item.hash === b[index]?.hash);
}

function sha(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRelative(workspaceRoot: string, absolute: string): string {
  assertLexical(workspaceRoot, absolute);
  return relative(workspaceRoot, absolute).replace(/\\/g, '/') || '.';
}

function assertLexical(workspaceRoot: string, target: string): void {
  const base = resolve(workspaceRoot);
  const absolute = resolve(target);
  if (absolute !== base && !absolute.startsWith(base + sep)) {
    throw new Error(`Mutation path outside workspace: ${target}`);
  }
}
