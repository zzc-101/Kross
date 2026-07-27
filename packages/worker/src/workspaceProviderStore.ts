import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';

import {
  modelProviderSchema,
  type ModelProfile
} from '@kross/protocol';
import { z } from 'zod';

const privateProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: modelProviderSchema,
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1)
});

const persistedSchema = z.object({
  version: z.literal(1),
  profiles: z.array(privateProfileSchema)
});

export type PrivateModelProfile = z.infer<typeof privateProfileSchema>;

/**
 * Workspace-owned model credentials. The file lives below KROSS_HOME in the
 * Worker volume and is deleted together with that workspace.
 */
export class WorkspaceProviderStore {
  private profiles = new Map<string, PrivateModelProfile>();

  constructor(private readonly path: string) {
    this.load();
  }

  list(): ModelProfile[] {
    return [...this.profiles.values()].map(toPublicProfile);
  }

  get(id: string): PrivateModelProfile | undefined {
    const profile = this.profiles.get(id);
    return profile ? structuredClone(profile) : undefined;
  }

  upsert(input: {
    label: string;
    provider: PrivateModelProfile['provider'];
    model: string;
    baseUrl?: string;
    apiKey: string;
  }): ModelProfile {
    const profile = privateProfileSchema.parse({
      ...input,
      id: `workspace:${randomUUID()}`
    });
    this.profiles.set(profile.id, profile);
    this.persist();
    return toPublicProfile(profile);
  }

  delete(id: string): boolean {
    const deleted = this.profiles.delete(id);
    if (!deleted) return false;
    this.persist();
    return true;
  }

  clear(): void {
    this.profiles.clear();
    rmSync(this.path, { force: true });
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = persistedSchema.parse(
      JSON.parse(readFileSync(this.path, 'utf8')) as unknown
    );
    for (const profile of parsed.profiles) {
      this.profiles.set(profile.id, profile);
    }
  }

  private persist(): void {
    if (this.profiles.size === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({
        version: 1,
        profiles: [...this.profiles.values()]
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    renameSync(temporary, this.path);
  }
}

function toPublicProfile(profile: PrivateModelProfile): ModelProfile {
  return {
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    scope: 'workspace',
    hasApiKey: true
  };
}
