import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';

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
    case 'git.status':
      return gitStatus(workspaceRoot, stringField(command.payload.path, '.'));
    case 'git.clone':
      return gitClone(
        workspaceRoot,
        stringField(command.payload.url, ''),
        optionalString(command.payload.directory)
      );
    case 'skills.list':
      return listSkills(workspaceRoot);
    case 'skills.upsert':
      return upsertSkill(workspaceRoot, command.payload);
    case 'skills.remove':
      return removeSkill(workspaceRoot, stringField(command.payload.id, ''));
    case 'mcp.save':
      return saveMcp(workspaceRoot, command.payload.servers);
    default:
      throw new Error(`Unsupported workspace command: ${command.name}`);
  }
}

async function listWorkspace(root: string, inputPath: string): Promise<Record<string, unknown>> {
  const target = resolveWorkPath(root, inputPath);
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
  const target = resolveWorkPath(root, inputPath);
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
  const target = resolveWorkPath(root, inputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  return { path: toRelative(root, target) };
}

async function gitStatus(root: string, inputPath: string): Promise<Record<string, unknown>> {
  const target = resolveWorkPath(root, inputPath);
  const repo = await findGitRoot(target, root);
  if (!repo) {
    return { path: toRelative(root, target), repository: false, dirty: false, files: [] };
  }
  const branch = (await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD';
  const porcelain = (await runGit(repo, ['status', '--porcelain=v1', '-uall'])).stdout;
  const files = porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => ({
      status: line.slice(0, 2).trim() || line.slice(0, 2),
      path: line.slice(3)
    }));
  return {
    path: toRelative(root, repo),
    repository: true,
    branch,
    dirty: files.length > 0,
    files
  };
}

async function gitClone(
  root: string,
  url: string,
  directory: string | undefined
): Promise<Record<string, unknown>> {
  const safeUrl = assertGitUrl(url);
  const relativeDir = directory?.trim() || join('files', repoNameFromUrl(safeUrl));
  const target = resolveWorkPath(root, relativeDir);
  try {
    await stat(target);
    throw new Error('Clone directory already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  const result = await runGit(root, ['clone', '--', safeUrl, toRelative(root, target)], 180_000);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'git clone failed');
  }
  return { directory: toRelative(root, target), url: safeUrl };
}

async function listSkills(root: string): Promise<Record<string, unknown>> {
  const skillsDir = resolveWorkPath(root, 'skills');
  await mkdir(skillsDir, { recursive: true });
  const names = (await readdir(skillsDir)).sort((left, right) => left.localeCompare(right));
  const items: Array<Record<string, unknown>> = [];
  for (const id of names) {
    try {
      const info = await stat(join(skillsDir, id));
      if (!info.isDirectory()) continue;
      const entry = join(skillsDir, id, 'SKILL.md');
      const content = await readFile(entry, 'utf8');
      const meta = parseSkillMarkdown(id, content);
      items.push({ id, ...meta, content });
    } catch {
      // skip unreadable skill folders
    }
  }
  return { items };
}

async function upsertSkill(root: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = assertResourceId(stringField(payload.id, ''), 'Skill id');
  const name = stringField(payload.name, id).trim() || id;
  const description = stringField(payload.description, '').trim();
  const body = stringField(payload.content, '');
  const content = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body.replace(/^\uFEFF/, '')
  ].join('\n');
  const target = resolveWorkPath(root, join('skills', id, 'SKILL.md'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  return { id, name, description, content };
}

async function removeSkill(root: string, id: string): Promise<Record<string, unknown>> {
  const safeId = assertResourceId(id, 'Skill id');
  const target = resolveWorkPath(root, join('skills', safeId));
  await rm(target, { recursive: true, force: true });
  return { id: safeId };
}

export async function writeMcpConfig(root: string, servers: unknown): Promise<Record<string, unknown>> {
  const map = normalizeMcpServers(servers);
  const krossHome = join(root, '.kross');
  await mkdir(krossHome, { recursive: true });
  await writeFile(
    join(krossHome, 'mcp.json'),
    `${JSON.stringify({ mcpServers: map }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return { servers: map };
}

async function saveMcp(root: string, servers: unknown): Promise<Record<string, unknown>> {
  return writeMcpConfig(root, servers);
}

function parseSkillMarkdown(id: string, content: string): { name: string; description: string } {
  let name = id;
  let description = '';
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const lines = content.split(/\r?\n/);
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closing > 0) {
      for (const line of lines.slice(1, closing)) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
        if (!match) continue;
        const key = match[1]!.toLowerCase();
        const value = match[2]!.trim().replace(/^['"]|['"]$/g, '');
        if (key === 'name' && value) name = value;
        if (key === 'description') description = value;
      }
    }
  }
  return { name, description };
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

function assertResourceId(value: string, label: string): string {
  const id = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`${label} must be 1-64 letters, digits, _ or -`);
  }
  return id;
}

async function findGitRoot(start: string, workspaceRoot: string): Promise<string | undefined> {
  let current = start;
  while (true) {
    try {
      const info = await stat(join(current, '.git'));
      if (info.isDirectory() || info.isFile()) return current;
    } catch {
      // keep walking up
    }
    if (current === workspaceRoot) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    const rel = relative(workspaceRoot, parent);
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
    current = parent;
  }
}

function resolveWorkPath(root: string, inputPath: string): string {
  const trimmed = (inputPath || '.').trim() || '.';
  const target = resolve(root, trimmed);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path is outside the workspace');
  }
  return target;
}

function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.replaceAll('\\', '/');
}

function assertGitUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 512 || /[\s\\;|&$`]/.test(trimmed)) {
    throw new Error('Invalid repository URL');
  }
  if (/^https:\/\//i.test(trimmed) || /^ssh:\/\//i.test(trimmed) || /^git@[^:]+:\S+$/.test(trimmed)) {
    return trimmed;
  }
  throw new Error('Only https, ssh, or git@ URLs are allowed');
}

function repoNameFromUrl(url: string): string {
  const cleaned = url.replace(/\/+$/, '').replace(/\.git$/i, '');
  const name = basename(cleaned);
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safe) throw new Error('Could not derive a clone directory from the URL');
  return safe;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 30_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('git command timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}
