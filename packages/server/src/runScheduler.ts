import type { SqlExecutor } from './database';
import type { RunLease } from './leaseQueue';
import { PostgresLeaseQueue } from './leaseQueue';
import type { OrchestratorClient, OrchestratorLaunchRequest } from './orchestratorClient';
import type { IssuedRunToken, PostgresWorkerControlService } from './workerControl';

const DEFAULT_RETRY_DELAY_MS = 5_000;

export interface RunSchedulerOptions {
  readonly owner: string;
  readonly publicBaseUrl: string;
  readonly leaseDurationMs?: number;
  readonly tokenTtlMs?: number;
  readonly retryDelayMs?: number;
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export class RunScheduler {
  private readonly leases: PostgresLeaseQueue;
  private readonly leaseDurationMs: number;
  private readonly tokenTtlMs: number;
  private readonly retryDelayMs: number;
  private readonly pollIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  public constructor(
    private readonly sql: SqlExecutor,
    transactions: ConstructorParameters<typeof PostgresLeaseQueue>[0],
    private readonly workerControl: Pick<PostgresWorkerControlService, 'issueRunToken'>,
    private readonly orchestrator: OrchestratorClient,
    private readonly options: RunSchedulerOptions
  ) {
    this.leases = new PostgresLeaseQueue(transactions);
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.tokenTtlMs = options.tokenTtlMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  public start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.runOnce()
        .catch((error) => this.options.onError?.(error))
        .finally(() => {
          if (this.timer) this.timer = setTimeout(tick, this.pollIntervalMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  public stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  public async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    let lease: RunLease | undefined;
    try {
      lease = await this.leases.claim(this.options.owner, this.leaseDurationMs);
      if (!lease) return false;
      const launch = await this.loadLaunch(lease);
      const issued = await this.workerControl.issueRunToken(lease, this.tokenTtlMs);
      await this.orchestrator.launch(this.buildRequest(lease, launch, issued));
      const updated = await this.sql.query(
        `UPDATE runs SET status = 'provisioning', worker_generation = $3, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'queued'
         RETURNING id`,
        [lease.organizationId, lease.runId, lease.generation]
      );
      if (updated.rowCount !== 1) {
        await this.orchestrator.cancel(lease.runId, lease.generation).catch(() => undefined);
        await this.release(lease, 0);
        return false;
      }
      return true;
    } catch (error) {
      if (lease) {
        await this.revokeToken(lease);
        await this.release(lease, this.retryDelayMs).catch(() => undefined);
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  public async cancel(runId: string, organizationId: string): Promise<void> {
    const result = await this.sql.query(
      `SELECT l.generation FROM runs r
       JOIN run_leases l ON l.organization_id = r.organization_id AND l.run_id = r.id
       WHERE r.organization_id = $1 AND r.id = $2 AND r.status = 'cancelling'
         AND l.status = 'leased'`,
      [organizationId, runId]
    );
    const generation = Number(result.rows[0]?.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      await this.sql.query(
        `WITH cancelled AS (
           UPDATE runs SET status = 'cancelled', finished_at = now(), updated_at = now()
           WHERE organization_id = $1 AND id = $2 AND status = 'cancelling'
           RETURNING id, organization_id
         )
         UPDATE run_leases l SET status = 'completed', available_at = now(), updated_at = now()
         FROM cancelled c WHERE l.organization_id = c.organization_id AND l.run_id = c.id
           AND l.status IN ('available','released')`,
        [organizationId, runId]
      );
      return;
    }
    await this.orchestrator.cancel(runId, generation);
  }

  private async loadLaunch(lease: RunLease): Promise<{
    resourceLimits: OrchestratorLaunchRequest['resourceLimits'];
    networkAccess: OrchestratorLaunchRequest['networkAccess'];
  }> {
    const result = await this.sql.query(
      `SELECT resource_limits, permission_policy FROM runs
       WHERE organization_id = $1 AND id = $2 AND status = 'queued'`,
      [lease.organizationId, lease.runId]
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Queued Run ${lease.runId} no longer exists`);
    const policy = asObject(row.permission_policy);
    return {
      resourceLimits: row.resource_limits as OrchestratorLaunchRequest['resourceLimits'],
      networkAccess: parseNetworkAccess(policy)
    };
  }

  private buildRequest(
    lease: RunLease,
    launch: Awaited<ReturnType<RunScheduler['loadLaunch']>>,
    issued: IssuedRunToken
  ): OrchestratorLaunchRequest {
    return {
      runId: lease.runId, generation: lease.generation, leaseId: lease.leaseId,
      runToken: issued.token,
      runSpecUrl: new URL('/internal/v2/workers/register', this.options.publicBaseUrl).toString(),
      tokenExpiresAt: issued.expiresAt,
      resourceLimits: launch.resourceLimits,
      networkAccess: launch.networkAccess
    };
  }

  private release(lease: RunLease, delayMs: number): Promise<void> {
    return this.leases.release(
      { organizationId: lease.organizationId, userId: 'run-scheduler', membershipId: 'run-scheduler', role: 'admin' },
      lease.leaseId, lease.owner, lease.generation, delayMs
    );
  }

  private async revokeToken(lease: RunLease): Promise<void> {
    await this.sql.query(
      `UPDATE worker_run_tokens SET revoked_at = now()
       WHERE organization_id = $1 AND run_id = $2 AND generation = $3
         AND lease_id = $4 AND revoked_at IS NULL`,
      [lease.organizationId, lease.runId, lease.generation, lease.leaseId]
    );
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseNetworkAccess(policy: Record<string, unknown>): OrchestratorLaunchRequest['networkAccess'] {
  const explicit = policy.networkAccess;
  if (explicit === 'restricted' || explicit === 'connector_proxy_only' || explicit === 'disabled') return explicit;
  return policy.allowNetworkAccess === true ? 'restricted' : 'disabled';
}
