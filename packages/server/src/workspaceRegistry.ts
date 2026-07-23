import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';

import {
  workspaceSchema,
  type CloudWorkspace
} from '@kross/protocol';
import { z } from 'zod';

const recordSchema = z.object({
  workspace: workspaceSchema,
  containerName: z.string().min(1),
  volumeName: z.string().min(1),
  workerToken: z.string().min(1)
});
const registrySchema = z.object({
  version: z.literal(1),
  workspaces: z.array(recordSchema)
});

export type WorkspaceRecord = z.infer<typeof recordSchema>;

export class WorkspaceRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(private readonly path: string) {
    this.load();
  }

  list(): CloudWorkspace[] {
    return [...this.records.values()]
      .map((record) => structuredClone(record.workspace))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): WorkspaceRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  put(record: WorkspaceRecord): void {
    this.records.set(record.workspace.id, structuredClone(record));
    this.persist();
  }

  delete(id: string): WorkspaceRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    this.records.delete(id);
    this.persist();
    return structuredClone(record);
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = registrySchema.safeParse(
      JSON.parse(readFileSync(this.path, 'utf8'))
    );
    if (!parsed.success) {
      throw new Error(`工作区注册表损坏: ${this.path}`);
    }
    for (const record of parsed.data.workspaces) {
      this.records.set(record.workspace.id, record);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(
        { version: 1, workspaces: [...this.records.values()] },
        null,
        2
      )}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    renameSync(temporary, this.path);
  }
}
