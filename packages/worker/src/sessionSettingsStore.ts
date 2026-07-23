import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import { thinkingEffortSchema } from '@kross/protocol';
import { z } from 'zod';

const settingsSchema = z.object({
  model: z.string().min(1).optional(),
  thinkingEffort: thinkingEffortSchema.optional()
});

export type CloudSessionSettings = z.infer<typeof settingsSchema>;

export class SessionSettingsStore {
  constructor(private readonly root: string) {}

  load(sessionId: string): CloudSessionSettings {
    const path = this.pathFor(sessionId);
    if (!existsSync(path)) return {};
    try {
      const parsed = settingsSchema.safeParse(
        JSON.parse(readFileSync(path, 'utf8'))
      );
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
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
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    renameSync(temporary, path);
    return settings;
  }

  private pathFor(sessionId: string): string {
    return join(this.root, `${encodeURIComponent(sessionId)}.json`);
  }
}
