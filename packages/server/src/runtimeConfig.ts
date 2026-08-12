import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  KROSS_DEV_IDENTITY: z.enum(['0', '1']).default('0')
});

export interface ServerRuntimeConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly devIdentityEnabled: boolean;
}

export function loadServerRuntimeConfig(environment: NodeJS.ProcessEnv): ServerRuntimeConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    devIdentityEnabled: parsed.KROSS_DEV_IDENTITY === '1'
  };
}
