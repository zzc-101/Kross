import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import {
  resolveExistingPathWithinWorkspace,
  resolveWritablePathWithinWorkspace
} from '../core/src/tools/builtin/paths';

const MAX_LIST_ENTRIES = 400;
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;

export type WorkerCommand = {
  commandId: string;
  name: string;
  payload: Record<string, unknown>;
};

export async function handleWorkspaceCommand(
  workspaceRoot: string,
  command: WorkerCommand
): Promise<Record<string, unknown>> {
  switch (command.name) {
    case 'workspace.list':
      return listWorkspace(workspaceRoot, stringField(command.payload.path, '.'));
    case 'workspace.read':
      return readWorkspaceFile(workspaceRoot, stringField(command.payload.path, ''));
    case 'workspace.write':
      return writeWorkspaceFile(
        workspaceRoot,
        stringField(command.payload.path, ''),
        stringField(command.payload.content, '')
      );
    default:
      throw new Error(`Unsupported workspace command: ${command.name}`);
  }
}

async function listWorkspace(root: string, inputPath: string): Promise<Record<string, unknown>> {
  const target = await resolveExistingPathWithinWorkspace(root, inputPath);
  const info = await stat(target);
  if (!info.isDirectory()) {
    throw new Error('Path is not a directory');
  }
  const names = (await readdir(target)).sort((left, right) => left.localeCompare(right));
  const entries: Array<Record<string, unknown>> = [];
  for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
    try {
      const child = await stat(join(target, name));
      entries.push({
        name,
        type: child.isDirectory() ? 'dir' : 'file',
        ...(child.isFile() ? { size: child.size } : {}),
        modifiedAt: child.mtime.toISOString()
      });
    } catch {
      // skip unreadable entries
    }
  }
  return { path: toRelative(root, target), entries };
}

async function readWorkspaceFile(root: string, inputPath: string): Promise<Record<string, unknown>> {
  const target = await resolveExistingPathWithinWorkspace(root, inputPath);
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error('Path is not a file');
  }
  if (info.size > MAX_READ_BYTES) {
    throw new Error('File is too large to open in the browser');
  }
  const content = await readFile(target, 'utf8');
  return { path: toRelative(root, target), content };
}

async function writeWorkspaceFile(
  root: string,
  inputPath: string,
  content: string
): Promise<Record<string, unknown>> {
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error('File content is too large');
  }
  const target = await resolveWritablePathWithinWorkspace(root, inputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  return { path: toRelative(root, target) };
}

export async function writeMcpConfig(root: string, servers: unknown): Promise<Record<string, unknown>> {
  const map = normalizeMcpServers(servers);
  const target = await resolveWritablePathWithinWorkspace(root, join('.kross', 'mcp.json'));
  const krossHome = dirname(target);
  await mkdir(krossHome, { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify({ mcpServers: map }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return { servers: map };
}

function normalizeMcpServers(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const root = value as Record<string, unknown>;
  const source = root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
    ? root.mcpServers as Record<string, unknown>
    : root;
  const next: Record<string, unknown> = {};
  for (const [id, config] of Object.entries(source)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) continue;
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    next[id] = config;
  }
  return next;
}

function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.replaceAll('\\', '/');
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
