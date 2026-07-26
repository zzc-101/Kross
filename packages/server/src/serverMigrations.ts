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
import { basename, dirname, join, parse, resolve } from 'node:path';

export const SERVER_MIGRATION_REPORT_VERSION = 1;

export interface ServerMigrationOptions {
  dataDir?: string;
  apply?: boolean;
  now?: () => Date;
  /** Test-only fault injection after backup and before a numbered write. */
  beforeWrite?: (relativePath: string, index: number) => void | Promise<void>;
}

export interface ServerMigrationChange {
  stepId: string;
  relativePath: string;
  beforeSha256: string;
  afterSha256: string;
}

export interface ServerMigrationReport {
  version: typeof SERVER_MIGRATION_REPORT_VERSION;
  boundary: 'cloud-control-plane';
  mode: 'dry-run' | 'apply';
  root: string;
  status: 'noop' | 'planned' | 'applied' | 'rolled-back' | 'blocked';
  changes: ServerMigrationChange[];
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

interface MigrationCandidate {
  stepId: string;
  relativePath: string;
  migrate(value: unknown): unknown | undefined;
}

const CANDIDATES: readonly MigrationCandidate[] = [
  {
    stepId: 'cloud.workspaces.version-1',
    relativePath: 'workspaces.json',
    migrate(value) {
      if (Array.isArray(value)) {
        return { version: 1, workspaces: value };
      }
      return addVersionToObject(value, 'workspaces.json', 'workspaces');
    }
  },
  {
    stepId: 'cloud.provider.version-1',
    relativePath: 'provider.json',
    migrate(value) {
      return addVersionToObject(value, 'provider.json', 'provider');
    }
  },
  {
    stepId: 'cloud.push-subscriptions.version-1',
    relativePath: 'push-subscriptions.json',
    migrate(value) {
      if (Array.isArray(value)) {
        return { version: 1, subscriptions: value };
      }
      return addVersionToObject(
        value,
        'push-subscriptions.json',
        'subscriptions'
      );
    }
  }
];

export async function runServerMigrations(
  options: ServerMigrationOptions = {}
): Promise<ServerMigrationReport> {
  const root = resolve(
    options.dataDir ??
      process.env.KROSS_SERVER_DATA ??
      '/var/lib/kross-server'
  );
  const mode = options.apply ? 'apply' : 'dry-run';
  if (root === parse(root).root) {
    return report(root, mode, 'blocked', [], {
      error: 'migration root cannot be a filesystem root'
    });
  }

  let planned: PlannedFile[];
  try {
    planned = await planServerMigrations(root);
  } catch (error) {
    return report(root, mode, 'blocked', [], { error: safeError(error) });
  }
  const changes = planned.map(toPublicChange);
  if (planned.length === 0) {
    return report(root, mode, 'noop', changes);
  }
  if (!options.apply) {
    return report(root, mode, 'planned', changes);
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, '.cloud-migration.lock');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    return report(root, mode, 'blocked', changes, {
      error: 'another cloud migration is already running'
    });
  }

  let backupPath: string | undefined;
  const written: PlannedFile[] = [];
  try {
    await assertPlansUnchanged(planned);
    backupPath = await backupMigration(
      root,
      planned,
      options.now?.() ?? new Date()
    );
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
        error: `${safeError(error)}; rollback failed: ${safeError(rollbackError)}`
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

async function planServerMigrations(root: string): Promise<PlannedFile[]> {
  const planned: PlannedFile[] = [];
  for (const candidate of CANDIDATES) {
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
    const migrated = candidate.migrate(value);
    if (migrated === undefined) continue;
    planned.push({
      stepId: candidate.stepId,
      relativePath: candidate.relativePath,
      absolutePath,
      before,
      after: Buffer.from(`${JSON.stringify(migrated, null, 2)}\n`, 'utf8'),
      mode: metadata.mode & 0o777
    });
  }
  return planned;
}

function addVersionToObject(
  value: unknown,
  relativePath: string,
  requiredField: string
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !(requiredField in value)) {
    throw new Error(
      `migration target has an unknown shape: ${relativePath}`
    );
  }
  if (value.version === 1) return undefined;
  if (value.version !== undefined) {
    throw new Error(
      `unsupported ${relativePath} version: ${String(value.version)}`
    );
  }
  return { ...value, version: 1 };
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
  const backupPath = join(root, '.migration-backups', `cloud-${stamp}`);
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
        boundary: 'cloud-control-plane',
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
  const temporary = join(
    dirname(path),
    `.${basename(path)}.migration-${process.pid}-${Date.now()}`
  );
  try {
    await writeFile(temporary, content, {
      mode: mode || 0o600,
      flag: 'wx'
    });
    await chmod(temporary, mode || 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function toPublicChange(file: PlannedFile): ServerMigrationChange {
  return {
    stepId: file.stepId,
    relativePath: file.relativePath,
    beforeSha256: sha256(file.before),
    afterSha256: sha256(file.after)
  };
}

function report(
  root: string,
  mode: ServerMigrationReport['mode'],
  status: ServerMigrationReport['status'],
  changes: ServerMigrationChange[],
  extra: Pick<ServerMigrationReport, 'backupPath' | 'error'> = {}
): ServerMigrationReport {
  return {
    version: SERVER_MIGRATION_REPORT_VERSION,
    boundary: 'cloud-control-plane',
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
