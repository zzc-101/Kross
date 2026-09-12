import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';

import {
  resolveExistingPathWithinWorkspace,
  resolveWritablePathWithinWorkspace
} from '../core/src/tools/builtin/paths';

const MAX_LIST_ENTRIES = 400;
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
export const MAX_PUT_BYTES = 10 * 1024 * 1024;

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
    case 'workspace.pull':
      return pullWorkspaceFile(workspaceRoot, command.payload);
    case 'workspace.push':
      return pushWorkspaceFile(workspaceRoot, command.payload);
    case 'workspace.delete':
      return deleteWorkspacePath(workspaceRoot, stringField(command.payload.path, ''));
    case 'workspace.mkdir':
      return mkdirWorkspace(workspaceRoot, stringField(command.payload.path, ''));
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
    if (isStagingName(name)) {
      continue;
    }
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

async function pullWorkspaceFile(
  root: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const requestedPath = stringField(payload.path, '');
  if (!requestedPath.trim()) {
    throw new Error('path is required');
  }
  const url = requireAllowedObjectUrl(payload.url);
  const totalSize = payload.totalSize === undefined
    ? undefined
    : integerField(payload.totalSize, 0);
  if (totalSize !== undefined && (totalSize < 0 || totalSize > MAX_PUT_BYTES)) {
    throw new Error('File is too large');
  }

  let relativePath = requestedPath.replaceAll('\\', '/');
  if (payload.ifExists !== 'error') {
    relativePath = await uniqueRelativePath(root, relativePath);
  }
  const target = await resolveWritablePathWithinWorkspace(root, relativePath);
  const staging = join(dirname(target), stagingName(basename(target)));
  await mkdir(dirname(target), { recursive: true });

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const handle = await open(staging, 'w', 0o600);
  let received = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        received += value.byteLength;
        if (received > MAX_PUT_BYTES) {
          throw new Error('File is too large');
        }
        if (totalSize !== undefined && received > totalSize) {
          throw new Error('Download exceeds declared size');
        }
        await handle.write(value);
      }
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(staging).catch(() => undefined);
    throw error;
  }
  await handle.close();
  if (totalSize !== undefined && received !== totalSize) {
    await unlink(staging).catch(() => undefined);
    throw new Error('Download size mismatch');
  }
  await rename(staging, target);
  const finalInfo = await stat(target);
  return {
    path: toRelative(root, target),
    size: finalInfo.size,
    received
  };
}

async function pushWorkspaceFile(
  root: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const target = await resolveExistingPathWithinWorkspace(root, stringField(payload.path, ''));
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error('Path is not a file');
  }
  if (info.size > MAX_PUT_BYTES) {
    throw new Error('File is too large');
  }
  const url = requireAllowedObjectUrl(payload.url);
  const mimeType = stringField(payload.mimeType, 'application/octet-stream') || 'application/octet-stream';
  const body = await readFile(target);
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': mimeType },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status})`);
  }
  return {
    path: toRelative(root, target),
    size: info.size
  };
}

function requireAllowedObjectUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('url is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid download url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid download url');
  }
  const allowed = allowedObjectHost();
  if (allowed) {
    if (parsed.host.toLowerCase() !== allowed) {
      throw new Error('Download host is not allowed');
    }
    return value;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error('Download host is not allowed');
  }
  return value;
}

function allowedObjectHost(): string | undefined {
  const raw = process.env.APP_S3_ENDPOINT?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    throw new Error('Invalid object storage endpoint');
  }
}

async function deleteWorkspacePath(
  root: string,
  inputPath: string
): Promise<Record<string, unknown>> {
  const target = await resolveExistingPathWithinWorkspace(root, inputPath);
  const info = await stat(target);
  if (info.isDirectory()) {
    const names = (await readdir(target)).filter((name) => !isStagingName(name));
    if (names.length > 0) {
      throw new Error('Directory is not empty');
    }
    await rmdir(target);
  } else {
    await unlink(target);
  }
  return { path: toRelative(root, target) };
}

async function mkdirWorkspace(
  root: string,
  inputPath: string
): Promise<Record<string, unknown>> {
  if (!inputPath.trim() || inputPath.trim() === '.') {
    throw new Error('path is required');
  }
  const target = await resolveWritablePathWithinWorkspace(root, inputPath);
  await mkdir(target, { recursive: true, mode: 0o700 });
  return { path: toRelative(root, target) };
}

export async function writeMcpConfig(root: string, servers: unknown): Promise<Record<string, unknown>> {
  const map = normalizeMcpServers(servers);
  const target = await resolveWritablePathWithinWorkspace(root, join('.kross', 'mcp.json'));
  const appHome = dirname(target);
  await mkdir(appHome, { recursive: true });
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

async function uniqueRelativePath(root: string, inputPath: string): Promise<string> {
  const normalized = inputPath.replaceAll('\\', '/').replace(/^\/+/, '');
  const dir = dirname(normalized);
  const file = basename(normalized);
  if (!file || file === '.' || file === '..') {
    throw new Error('Invalid file name');
  }
  const extension = extname(file);
  const stem = extension ? file.slice(0, -extension.length) : file;
  let candidate = file;
  let index = 1;
  while (await pathExists(root, dir === '.' ? candidate : `${dir}/${candidate}`)) {
    candidate = `${stem} (${index})${extension}`;
    index += 1;
  }
  return dir === '.' ? candidate : `${dir}/${candidate}`;
}

async function pathExists(root: string, relativePath: string): Promise<boolean> {
  try {
    const target = await resolveWritablePathWithinWorkspace(root, relativePath);
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function stagingName(fileName: string): string {
  return `.${fileName}.uploading`;
}

function isStagingName(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.uploading');
}

function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.replaceAll('\\', '/');
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function integerField(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}
