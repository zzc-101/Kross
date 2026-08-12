import { z } from 'zod';

const handleSchema = z.object({
  runId: z.string().min(1), generation: z.number().int().positive(),
  containerId: z.string().min(1), containerName: z.string().min(1),
  volumeName: z.string().min(1), networkName: z.string().min(1).optional(),
  deadlineAt: z.string().datetime({ offset: true })
}).strict();
const inspectionSchema = handleSchema.extend({
  state: z.enum(['created', 'running', 'exited', 'missing']),
  startedAt: z.string().datetime({ offset: true }).optional(),
  finishedAt: z.string().datetime({ offset: true }).optional(),
  exitCode: z.number().int().optional()
}).strict();

export interface OrchestratorLaunchRequest {
  readonly runId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly runToken: string;
  readonly runSpecUrl: string;
  readonly tokenExpiresAt: string;
  readonly resourceLimits: {
    readonly cpuMillis: number; readonly memoryBytes: number;
    readonly maxPids: number; readonly diskBytes: number;
    readonly maxDurationMs: number; readonly maxSourceBytes: number;
    readonly maxArtifactBytes: number; readonly maxEventPayloadBytes: number;
    readonly maxTokens?: number; readonly maxCostUsd?: number;
  };
  readonly networkAccess: 'restricted' | 'connector_proxy_only' | 'disabled';
}

export interface OrchestratorClient {
  launch(request: OrchestratorLaunchRequest): Promise<z.infer<typeof handleSchema>>;
  cancel(runId: string, generation: number): Promise<z.infer<typeof inspectionSchema>>;
}

export class HttpOrchestratorClient implements OrchestratorClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {
    if (serviceToken.length < 32) throw new Error('Orchestrator service token is too short');
  }

  public launch(request: OrchestratorLaunchRequest) {
    return this.post('/internal/runs/launch', request, handleSchema);
  }

  public cancel(runId: string, generation: number) {
    return this.post('/internal/runs/cancel', { runId, generation }, inspectionSchema);
  }

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) }).safeParse(payload);
      throw new OrchestratorClientError(
        response.status, parsed.success ? parsed.data.error.code : 'ORCHESTRATOR_HTTP_ERROR',
        parsed.success ? parsed.data.error.message ?? parsed.data.error.code : `Orchestrator HTTP ${response.status}`
      );
    }
    return schema.parse(payload);
  }
}

export class OrchestratorClientError extends Error {
  public constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
