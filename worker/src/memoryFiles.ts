import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ContextSource } from '../core/src/context/sessionContext';

export const USER_MARKDOWN_BUDGET = 1_375;
export const MEMORY_MARKDOWN_BUDGET = 2_200;

const USER_STUB = '# User\n\nDescribe preferences for this Agent.\n';
const MEMORY_STUB = '# Memory\n\nLong-term notes for this Agent.\n';

export async function writeMemoryFiles(
  root: string,
  userMarkdown: string | undefined,
  memoryMarkdown: string | undefined
): Promise<void> {
  if (userMarkdown !== undefined) {
    await writeFile(join(root, 'USER.md'), userMarkdown, { encoding: 'utf8', mode: 0o600 });
  }
  if (memoryMarkdown !== undefined) {
    await writeFile(join(root, 'MEMORY.md'), memoryMarkdown, { encoding: 'utf8', mode: 0o600 });
  }
}

export function loadMemoryContextSources(workspaceRoot?: string): ContextSource[] {
  if (!workspaceRoot) return [];
  return [
    readPinnedSource(
      workspaceRoot,
      'USER.md',
      'user-preferences',
      'user',
      'User preferences',
      98,
      USER_MARKDOWN_BUDGET,
      USER_STUB
    ),
    readPinnedSource(
      workspaceRoot,
      'MEMORY.md',
      'long-term-memory',
      'memory',
      'Long-term memory',
      99,
      MEMORY_MARKDOWN_BUDGET,
      MEMORY_STUB
    )
  ].filter((source): source is ContextSource => source !== undefined);
}

export function clipBudget(content: string, budget: number): string {
  if (content.length <= budget) return content;
  return `${content.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
}

function readPinnedSource(
  root: string,
  fileName: string,
  id: string,
  kind: 'user' | 'memory',
  title: string,
  priority: number,
  budget: number,
  stub: string
): ContextSource | undefined {
  let content = '';
  try {
    content = readFileSync(join(root, fileName), 'utf8');
  } catch {
    return undefined;
  }
  if (!hasInjectableMemory(content, stub)) {
    return undefined;
  }
  return {
    id,
    kind,
    title,
    content: clipBudget(content.trim(), budget),
    pinned: true,
    priority
  };
}

function hasInjectableMemory(content: string, stub: string): boolean {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized === stub.trim()) return false;
  const withoutHeading = normalized.replace(/^#\s+\w+\s*/u, '').trim();
  return withoutHeading.length > 0;
}
