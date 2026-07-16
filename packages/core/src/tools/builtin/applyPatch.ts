import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { MutationService } from '../../mutations/mutationService';
import type { ToolDefinition } from '../toolGateway';
import {
  resolveExistingPathWithinWorkspace,
  resolveWritablePathWithinWorkspace
} from './paths';

interface ApplyPatchInput {
  patch: string;
}

interface PatchOperation {
  kind: 'add' | 'update' | 'delete';
  path: string;
  body: string[];
}

interface PlannedFile {
  kind: PatchOperation['kind'];
  path: string;
  absolute: string;
  content?: string;
}

const MAX_PATCH_BYTES = 512 * 1024;

export function createApplyPatchTool(
  workspaceRoot: string,
  mutations: MutationService
): ToolDefinition<ApplyPatchInput> {
  return {
    name: 'ApplyPatch',
    description:
      '原子应用 *** Begin Patch 格式的多文件补丁，支持 Add/Update/Delete File。任一路径或 hunk 失败时不写入任何文件。',
    risk: 'write',
    category: 'filesystem',
    inputSchema: z.object({
      patch: z.string().min(1).refine(
        (value) =>
          !value.includes('\0') &&
          Buffer.byteLength(value, 'utf8') <= MAX_PATCH_BYTES,
        'Patch must be text and at most 512 KiB'
      )
    }),
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: '*** Begin Patch / *** Add|Update|Delete File / *** End Patch 格式'
        }
      },
      required: ['patch'],
      additionalProperties: false
    },
    execute: async ({ input, runId }) => {
      const operations = parsePatch(input.patch);
      const planned = await planOperations(workspaceRoot, operations);
      await mutations.record({
        runId,
        toolName: 'ApplyPatch',
        paths: planned.map((item) => item.path),
        action: async () => {
          for (const item of planned) {
            if (item.kind === 'delete') {
              await rm(item.absolute, { force: false });
            } else {
              await mkdir(dirname(item.absolute), { recursive: true });
              await writeFile(item.absolute, item.content ?? '', 'utf8');
            }
          }
        }
      });
      const counts = {
        added: planned.filter((item) => item.kind === 'add').length,
        updated: planned.filter((item) => item.kind === 'update').length,
        deleted: planned.filter((item) => item.kind === 'delete').length
      };
      return {
        content: `Patch applied: ${counts.added} added, ${counts.updated} updated, ${counts.deleted} deleted`,
        summary: `${planned.length} files patched`,
        data: { files: planned.map((item) => item.path), ...counts }
      };
    }
  };
}

export function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '*** Begin Patch') {
    throw new Error('Patch must start with *** Begin Patch');
  }
  const operations: PatchOperation[] = [];
  let current: PatchOperation | undefined;
  let sawEnd = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === '*** End Patch') {
      if (current) operations.push(current);
      current = undefined;
      sawEnd = true;
      if (lines.slice(i + 1).some((item) => item.trim())) {
        throw new Error('Unexpected content after *** End Patch');
      }
      break;
    }
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (current) operations.push(current);
      current = {
        kind: header[1]!.toLowerCase() as PatchOperation['kind'],
        path: header[2]!.trim(),
        body: []
      };
      if (!current.path) throw new Error('Patch file path must not be empty');
      continue;
    }
    if (!current) {
      if (line.trim()) throw new Error(`Unexpected patch line: ${line}`);
      continue;
    }
    current.body.push(line);
  }
  if (!sawEnd) throw new Error('Patch must end with *** End Patch');
  if (operations.length === 0) throw new Error('Patch has no file operations');
  const duplicates = operations
    .map((item) => item.path)
    .filter((path, index, all) => all.indexOf(path) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Patch contains duplicate paths: ${[...new Set(duplicates)].join(', ')}`);
  }
  return operations;
}

async function planOperations(
  workspaceRoot: string,
  operations: PatchOperation[]
): Promise<PlannedFile[]> {
  const planned: PlannedFile[] = [];
  for (const operation of operations) {
    if (operation.kind === 'add') {
      const absolute = await resolveWritablePathWithinWorkspace(workspaceRoot, operation.path);
      try {
        await lstat(absolute);
        throw new Error(`Cannot add existing file: ${operation.path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const contentLines = operation.body.map((line) => {
        if (!line.startsWith('+')) throw new Error(`Add File lines must start with +: ${operation.path}`);
        return line.slice(1);
      });
      planned.push({
        kind: 'add',
        path: operation.path,
        absolute,
        content: `${contentLines.join('\n')}\n`
      });
      continue;
    }

    const absolute = await resolveExistingPathWithinWorkspace(workspaceRoot, operation.path);
    const meta = await lstat(absolute);
    if (!meta.isFile()) throw new Error(`Patch target is not a regular file: ${operation.path}`);
    if (operation.kind === 'delete') {
      if (operation.body.some((line) => line.trim())) {
        throw new Error(`Delete File must not contain hunks: ${operation.path}`);
      }
      planned.push({ kind: 'delete', path: operation.path, absolute });
      continue;
    }
    const original = await readFile(absolute, 'utf8');
    planned.push({
      kind: 'update',
      path: operation.path,
      absolute,
      content: applyUpdateHunks(original, operation)
    });
  }
  return planned;
}

function applyUpdateHunks(original: string, operation: PatchOperation): string {
  const hunks: string[][] = [];
  let current: string[] = [];
  for (const line of operation.body) {
    if (line.startsWith('@@')) {
      if (current.length > 0) hunks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) hunks.push(current);
  if (hunks.length === 0) throw new Error(`Update File has no hunks: ${operation.path}`);

  let content = original;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk) {
      const prefix = line[0];
      const value = line.slice(1);
      if (prefix === ' ') {
        oldLines.push(value);
        newLines.push(value);
      } else if (prefix === '-') {
        oldLines.push(value);
      } else if (prefix === '+') {
        newLines.push(value);
      } else if (line === '') {
        throw new Error(`Malformed empty hunk line in ${operation.path}`);
      } else {
        throw new Error(`Malformed hunk line in ${operation.path}: ${line}`);
      }
    }
    const oldText = oldLines.join('\n');
    const newText = newLines.join('\n');
    if (!oldText) throw new Error(`Update hunk has no preimage: ${operation.path}`);
    const first = content.indexOf(oldText);
    if (first < 0) throw new Error(`Hunk does not match file: ${operation.path}`);
    if (content.indexOf(oldText, first + 1) >= 0) {
      throw new Error(`Hunk is ambiguous in file: ${operation.path}`);
    }
    content = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
  }
  return content;
}
