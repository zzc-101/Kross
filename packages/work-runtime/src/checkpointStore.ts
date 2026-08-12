import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkRuntimeCheckpoint {
  version: 1;
  runId: string;
  generation: number;
  contextState: unknown;
  workState: unknown;
  savedAt: string;
}

export interface SavedCheckpoint {
  key: string;
  sha256: string;
  sizeBytes: number;
}

export class FileCheckpointStore {
  constructor(private readonly directory: string) {}

  async save(checkpoint: WorkRuntimeCheckpoint): Promise<SavedCheckpoint> {
    await mkdir(this.directory, { recursive: true });
    const key = `run-${checkpoint.runId}-generation-${checkpoint.generation}.json`;
    const path = join(this.directory, key);
    const temporary = `${path}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(checkpoint)}\n`, 'utf8');
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
    return {
      key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength
    };
  }

  async load(key: string): Promise<WorkRuntimeCheckpoint | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,1023}$/.test(key)) {
      throw new Error('Unsafe checkpoint key');
    }
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, key), 'utf8')) as WorkRuntimeCheckpoint;
      if (parsed.version !== 1) throw new Error('Unsupported checkpoint version');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
