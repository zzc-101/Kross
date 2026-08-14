import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';

export const CORE_MIGRATION_REPORT_VERSION = 1;

export interface CoreMigrationOptions {
  homeDir?: string;
  krossHome?: string;
  apply?: boolean;
  now?: () => Date;
  /** Test-only fault injection after backup and before a numbered write. */
  beforeWrite?: (relativePath: string, index: number) => void | Promise<void>;
}

export interface CoreMigrationChange {
  stepId: string;
  relativePath: string;
  beforeSha256: string;
  afterSha256: string;
}

export interface CoreMigrationReport {
  version: typeof CORE_MIGRATION_REPORT_VERSION;
  boundary: 'core-local';
  mode: 'dry-run' | 'apply';
  root: string;
  status: 'noop' | 'planned' | 'applied' | 'rolled-back' | 'blocked';
  changes: CoreMigrationChange[];
  backupPath?: string;
  error?: string;
}

interface PlannedFile {
  stepId: string;
  relativePath: string;
  absolutePath: string;
  before: Buffer;
  after: Buffer;
  mode: number;
}

export async function runCoreMigrations(
  options: CoreMigrationOptions = {}
): Promise<CoreMigrationReport> {
  const root = resolve(
    options.krossHome ?? join(options.homeDir ?? homedir(), '.kross')
  );
  const mode = options.apply ? 'apply' : 'dry-run';
  if (root === parse(root).root) {
    return report(root, mode, 'blocked', [], {
      error: 'migration root cannot be a filesystem root'
    });
  }
  let planned: PlannedFile[];
  try {
    planned = await planCoreMigrations(root);
  } catch (error) {
    return report(root, mode, 'blocked', [], {
      error: safeError(error)
    });
  }
  const changes = planned.map(toPublicChange);
  if (planned.length === 0) {
    return report(root, mode, 'noop', changes);
  }
  if (!options.apply) {
    return report(root, mode, 'planned', changes);
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, '.migration.lock');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    return report(root, mode, 'blocked', changes, {
      error: 'another migration is already running'
    });
  }

  let backupPath: string | undefined;
  const written: PlannedFile[] = [];
  try {
    await assertPlansUnchanged(planned);
    backupPath = await backupMigration(root, planned, options.now?.() ?? new Date());
    for (const [index, file] of planned.entries()) {
      await options.beforeWrite?.(file.relativePath, index);
      await atomicWrite(file.absolutePath, file.after, file.mode);
      written.push(file);
    }
    return report(root, mode, 'applied', changes, { backupPath });
  } catch (error) {
    try {
      for (const file of [...written].reverse()) {
        await atomicWrite(file.absolutePath, file.before, file.mode);
      }
    } catch (rollbackError) {
      return report(root, mode, 'blocked', changes, {
        backupPath,
        error:
          `${safeError(error)}; rollback failed: ${safeError(rollbackError)}`
      });
    }
    return report(root, mode, 'rolled-back', changes, {
      backupPath,
      error: safeError(error)
    });
  } finally {
    await lock?.close();
    await rm(lockPath, { force: true });
  }
}

async function planCoreMigrations(root: string): Promise<PlannedFile[]> {
  const candidates = [
    { stepId: 'core.config.version-1', relativePath: 'config.json' },
    { stepId: 'core.projects.version-1', relativePath: 'projects.json' }
  ];
  const planned: PlannedFile[] = [];
  for (const candidate of candidates) {
    const absolutePath = join(root, candidate.relativePath);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `migration target must be a regular file: ${candidate.relativePath}`
      );
    }
    const before = await readFile(absolutePath);
    let value: unknown;
    try {
      value = JSON.parse(before.toString('utf8')) as unknown;
    } catch {
      throw new Error(`invalid JSON: ${candidate.relativePath}`);
    }
    if (!isRecord(value)) {
      throw new Error(`migration target must contain an object: ${candidate.relativePath}`);
    }
    if (value.version === 1) continue;
    if (value.version !== undefined) {
      throw new Error(
        `unsupported ${candidate.relativePath} version: ${String(value.version)}`
      );
    }
    const after = Buffer.from(
      `${JSON.stringify({ ...value, version: 1 }, null, 2)}\n`,
      'utf8'
    );
    planned.push({
      ...candidate,
      absolutePath,
      before,
      after,
      mode: metadata.mode & 0o777
    });
  }
  return planned;
}

async function assertPlansUnchanged(planned: PlannedFile[]): Promise<void> {
  for (const file of planned) {
    const current = await readFile(file.absolutePath);
    if (!current.equals(file.before)) {
      throw new Error(
        `migration target changed after planning: ${file.relativePath}`
      );
    }
  }
}

async function backupMigration(
  root: string,
  planned: PlannedFile[],
  now: Date
): Promise<string> {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupPath = join(root, '.migration-backups', stamp);
  await mkdir(backupPath, { recursive: true, mode: 0o700 });
  for (const file of planned) {
    const target = join(backupPath, 'files', file.relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(file.absolutePath, target);
    await chmod(target, 0o600);
  }
  await writeFile(
    join(backupPath, 'manifest.json'),
    `${JSON.stringify(
      {
        version: 1,
        boundary: 'core-local',
        createdAt: now.toISOString(),
        root,
        files: planned.map(toPublicChange)
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return backupPath;
}

async function atomicWrite(
  path: string,
  content: Buffer,
  mode: number
): Promise<void> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.migration-${process.pid}-${Date.now()}`
  );
  try {
    await writeFile(temp, content, { mode: mode || 0o600, flag: 'wx' });
    await chmod(temp, mode || 0o600);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function toPublicChange(file: PlannedFile): CoreMigrationChange {
  return {
    stepId: file.stepId,
    relativePath: file.relativePath,
    beforeSha256: sha256(file.before),
    afterSha256: sha256(file.after)
  };
}

function report(
  root: string,
  mode: CoreMigrationReport['mode'],
  status: CoreMigrationReport['status'],
  changes: CoreMigrationChange[],
  extra: Pick<CoreMigrationReport, 'backupPath' | 'error'> = {}
): CoreMigrationReport {
  return {
    version: CORE_MIGRATION_REPORT_VERSION,
    boundary: 'core-local',
    mode,
    root,
    status,
    changes,
    ...(extra.backupPath ? { backupPath: extra.backupPath } : {}),
    ...(extra.error ? { error: extra.error } : {})
  };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
