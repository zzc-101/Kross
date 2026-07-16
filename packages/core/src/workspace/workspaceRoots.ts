import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { ImpactMap, ImpactRepo } from '../domain';
import { impactMapSchema } from '../domain';

export interface WorkspaceRootEntry {
  /** Short id for Task(repoId=…) — defaults to directory basename. */
  id: string;
  path: string;
  primary: boolean;
}

/**
 * Session-scoped multi-directory workspace (Claude-style /add-dir).
 * Primary root is the process cwd; extras expand Task allowlist.
 */
export class WorkspaceRoots {
  private readonly primaryPath: string;
  private readonly extra = new Map<string, string>(); // id -> absolute path

  constructor(primaryPath: string) {
    this.primaryPath = resolve(primaryPath);
  }

  get primary(): string {
    return this.primaryPath;
  }

  list(): WorkspaceRootEntry[] {
    const entries: WorkspaceRootEntry[] = [
      {
        id: basename(this.primaryPath) || 'primary',
        path: this.primaryPath,
        primary: true
      }
    ];
    for (const [id, path] of this.extra) {
      entries.push({ id, path, primary: false });
    }
    return entries;
  }

  /** Absolute roots allowed for multi-root Task / subagent. */
  allowedRoots(): string[] {
    return [this.primaryPath, ...this.extra.values()];
  }

  resolveById(id: string): string | undefined {
    const trimmed = id.trim();
    if (!trimmed) {
      return undefined;
    }
    if (this.extra.has(trimmed)) {
      return this.extra.get(trimmed);
    }
    const primaryId = basename(this.primaryPath) || 'primary';
    if (trimmed === primaryId || trimmed === 'primary' || trimmed === '.') {
      return this.primaryPath;
    }
    return undefined;
  }

  /**
   * Add a directory. Returns the assigned id.
   * Rejects non-directories and duplicates.
   */
  add(rawPath: string, preferredId?: string): { id: string; path: string } {
    const path = resolve(rawPath.trim());
    if (!existsSync(path)) {
      throw new Error(`Path does not exist: ${path}`);
    }
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new Error(`Not a directory: ${path}`);
    }
    if (path === this.primaryPath) {
      throw new Error(`Already the primary workspace: ${path}`);
    }
    for (const [id, existing] of this.extra) {
      if (existing === path) {
        return { id, path };
      }
    }

    let id = (preferredId?.trim() || basename(path) || 'dir').replace(
      /[^A-Za-z0-9._-]+/g,
      '_'
    );
    if (!id) {
      id = 'dir';
    }
    // Avoid colliding with primary basename or existing ids
    const primaryId = basename(this.primaryPath) || 'primary';
    if (id === primaryId || this.extra.has(id)) {
      let n = 2;
      while (this.extra.has(`${id}-${n}`) || `${id}-${n}` === primaryId) {
        n += 1;
      }
      id = `${id}-${n}`;
    }
    this.extra.set(id, path);
    return { id, path };
  }

  remove(pathOrId: string): boolean {
    const key = pathOrId.trim();
    if (!key) {
      return false;
    }
    if (this.extra.has(key)) {
      this.extra.delete(key);
      return true;
    }
    const resolved = resolve(key);
    if (resolved === this.primaryPath) {
      throw new Error('Cannot remove the primary workspace root');
    }
    for (const [id, path] of this.extra) {
      if (path === resolved) {
        this.extra.delete(id);
        return true;
      }
    }
    return false;
  }

  formatForPrompt(): string {
    const lines = this.list().map((entry) => {
      const tag = entry.primary ? 'primary' : 'added';
      return `- id=${entry.id} (${tag}) path=${entry.path}`;
    });
    return [
      'Workspace roots (Task may use repoId=id to target a root):',
      ...lines,
      'Add more with /add-dir <path>; list with /dirs; remove with /remove-dir <id|path>.'
    ].join('\n');
  }

  /**
   * Impact map from current roots only (no registry). Used by conductor mode.
   */
  toImpactMap(goal: string): ImpactMap {
    const repos: ImpactRepo[] = this.list().map((entry) => ({
      id: entry.id,
      path: entry.path,
      type: entry.primary ? 'primary' : 'workspace',
      reasons: entry.primary
        ? ['primary workspace root']
        : ['added via /add-dir'],
      tasks: [
        [
          `在工作区 ${entry.id}（${entry.path}）中推进任务。`,
          `总体目标：${goal.trim()}`,
          entry.primary
            ? '这是主工作区。'
            : '这是通过 /add-dir 加入的额外目录。',
          '只修改本目录内文件；完成后给出变更摘要、关键路径与风险。'
        ].join('\n')
      ]
    }));
    return impactMapSchema.parse({
      strategy: 'heuristic',
      projectId: 'workspace',
      repos
    });
  }
}
