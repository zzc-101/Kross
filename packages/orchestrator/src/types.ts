import type { RunSpec } from '@kross/protocol';

export type RunResourceLimits = RunSpec['resourceLimits'];
export type RunNetworkAccess = RunSpec['policy']['networkAccess'];

export interface RunLaunchRequest {
  runId: string;
  generation: number;
  leaseId: string;
  /** Single-use or short-lived token; never a provider or connector credential. */
  runToken: string;
  runSpecUrl: string;
  tokenExpiresAt: string;
  resourceLimits: RunResourceLimits;
  networkAccess: RunNetworkAccess;
}

export interface BackendHandle {
  runId: string;
  generation: number;
  containerId: string;
  containerName: string;
  volumeName: string;
  networkName?: string;
  deadlineAt: string;
}

export type BackendState =
  | 'created'
  | 'running'
  | 'exited'
  | 'missing';

export interface BackendInspection extends BackendHandle {
  state: BackendState;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface ManagedExecution extends BackendInspection {}

/** Backend-neutral execution boundary; no public user or control-plane API lives here. */
export interface ContainerBackend {
  launch(request: RunLaunchRequest): Promise<BackendHandle>;
  inspect(handle: BackendHandle): Promise<BackendInspection>;
  terminate(handle: BackendHandle): Promise<void>;
  remove(handle: BackendHandle): Promise<void>;
  listManaged(): Promise<ManagedExecution[]>;
  /** Removes backend resources whose owning execution no longer exists. */
  reapInfrastructureOrphans(): Promise<number>;
  health(): Promise<boolean>;
}

export type OrchestratorScope =
  | 'run:launch'
  | 'run:cancel'
  | 'run:inspect'
  | 'run:reap';

export interface OrchestratorPrincipal {
  serviceId: string;
  scopes: readonly OrchestratorScope[];
}

export interface AuthorizationContext {
  principal: OrchestratorPrincipal;
}

export interface OrchestratorAuthorizer {
  authorize(
    context: AuthorizationContext,
    scope: OrchestratorScope,
    runId?: string
  ): void | Promise<void>;
}

export interface ActiveRunGeneration {
  runId: string;
  generation: number;
}

export interface ReapRequest {
  activeRuns: readonly ActiveRunGeneration[];
  terminalRunIds: readonly string[];
  now?: string;
}

export interface ReapResult {
  removed: Array<{
    runId: string;
    generation: number;
    reason: 'terminal' | 'timeout' | 'orphan' | 'stale_generation';
  }>;
}
