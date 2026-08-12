import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  KROSS_DEV_IDENTITY: z.enum(['0', '1']).default('0'),
  KROSS_BLOB_ROOT: z.string().min(1).default('.kross-cloud/blobs'),
  KROSS_BLOB_SIGNING_SECRET: z.string().min(32),
  KROSS_PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:8787'),
  KROSS_ORCHESTRATOR_URL: z.string().url().optional(),
  KROSS_ORCHESTRATOR_SERVICE_TOKEN: z.string().min(32).optional(),
  KROSS_SCHEDULER_OWNER: z.string().min(1).max(128).default('kross-server')
}).superRefine((value, context) => {
  if ((value.KROSS_ORCHESTRATOR_URL === undefined) !== (value.KROSS_ORCHESTRATOR_SERVICE_TOKEN === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Orchestrator URL and service token must be configured together' });
  }
});

export interface ServerRuntimeConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly devIdentityEnabled: boolean;
  readonly blobRoot: string;
  readonly blobSigningSecret: string;
  readonly publicBaseUrl: string;
  readonly orchestratorUrl?: string;
  readonly orchestratorServiceToken?: string;
  readonly schedulerOwner: string;
}

export function loadServerRuntimeConfig(environment: NodeJS.ProcessEnv): ServerRuntimeConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    devIdentityEnabled: parsed.KROSS_DEV_IDENTITY === '1',
    blobRoot: parsed.KROSS_BLOB_ROOT,
    blobSigningSecret: parsed.KROSS_BLOB_SIGNING_SECRET,
    publicBaseUrl: parsed.KROSS_PUBLIC_BASE_URL,
    ...(parsed.KROSS_ORCHESTRATOR_URL === undefined ? {} : { orchestratorUrl: parsed.KROSS_ORCHESTRATOR_URL }),
    ...(parsed.KROSS_ORCHESTRATOR_SERVICE_TOKEN === undefined ? {} : { orchestratorServiceToken: parsed.KROSS_ORCHESTRATOR_SERVICE_TOKEN }),
    schedulerOwner: parsed.KROSS_SCHEDULER_OWNER
  };
}
