import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import {
  permissionModeSchema,
  thinkingEffortSchema
} from '@kross/protocol';
import { z } from 'zod';

import {
  assertWorkerDataVersion,
  isRecord
} from './persistenceVersion';

const settingsSchema = z.object({
  model: z.string().min(1).optional(),
  modelProfileId: z.string().min(1).optional(),
  thinkingEffort: thinkingEffortSchema.optional(),
  permissionMode: permissionModeSchema.optional()
});
const persistedSettingsSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema
});

export type CloudSessionSettings = z.infer<typeof settingsSchema>;

export class SessionSettingsStore {
  constructor(private readonly root: string) {}

  load(sessionId: string): CloudSessionSettings {
    const path = this.pathFor(sessionId);
    if (!existsSync(path)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return {};
    }
    if (isRecord(raw) && raw.version !== undefined) {
      assertWorkerDataVersion(raw, {
        format: 'Worker session settings',
        supportedVersion: 1
      });
      const parsed = persistedSettingsSchema.safeParse(raw);
      return parsed.success ? parsed.data.settings : {};
    }
    const legacy = settingsSchema.safeParse(raw);
    return legacy.success ? legacy.data : {};
  }

  update(
    sessionId: string,
    patch: CloudSessionSettings
  ): CloudSessionSettings {
    const settings = settingsSchema.parse({
      ...this.load(sessionId),
      ...patch
    });
    mkdirSync(this.root, { recursive: true });
    const path = this.pathFor(sessionId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, settings }, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );
    renameSync(temporary, path);
    return settings;
  }

  delete(sessionId: string): void {
    rmSync(this.pathFor(sessionId), { force: true });
  }

  private pathFor(sessionId: string): string {
    return join(this.root, `${encodeURIComponent(sessionId)}.json`);
  }
}
