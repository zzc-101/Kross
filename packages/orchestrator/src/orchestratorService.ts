import {
  ExecutionNotFoundError,
  StaleGenerationError
} from './errors';
import type {
  AuthorizationContext,
  BackendHandle,
  BackendInspection,
  ContainerBackend,
  OrchestratorAuthorizer,
  ReapRequest,
  ReapResult,
  RunLaunchRequest
} from './types';

export class OrchestratorService {
  private readonly launches = new Map<string, Promise<BackendHandle>>();

  constructor(
    private readonly backend: ContainerBackend,
    private readonly authorizer: OrchestratorAuthorizer
  ) {}

  async health(): Promise<{ ok: boolean }> {
    return { ok: await this.backend.health() };
  }

  async launch(
    context: AuthorizationContext,
    request: RunLaunchRequest
  ): Promise<BackendHandle> {
    await this.authorizer.authorize(context, 'run:launch', request.runId);
    const pending = this.launches.get(request.runId);
    if (pending) {
      const handle = await pending;
      if (handle.generation === request.generation) return handle;
    }

    const operation = this.launchExclusive(request);
    this.launches.set(request.runId, operation);
    try {
      return await operation;
    } finally {
      if (this.launches.get(request.runId) === operation) {
        this.launches.delete(request.runId);
      }
    }
  }

  async cancel(
    context: AuthorizationContext,
    runId: string,
    generation: number
  ): Promise<BackendInspection> {
    await this.authorizer.authorize(context, 'run:cancel', runId);
    const handle = await this.findExact(runId, generation);
    await this.backend.terminate(handle);
    return this.backend.inspect(handle);
  }

  async inspect(
    context: AuthorizationContext,
    runId: string,
    generation: number
  ): Promise<BackendInspection> {
    await this.authorizer.authorize(context, 'run:inspect', runId);
    return this.backend.inspect(await this.findExact(runId, generation));
  }

  async reap(
    context: AuthorizationContext,
    request: ReapRequest
  ): Promise<ReapResult> {
    await this.authorizer.authorize(context, 'run:reap');
    const now = request.now ? Date.parse(request.now) : Date.now();
    const activeByRun = new Map(
      request.activeRuns.map((entry) => [entry.runId, entry.generation])
    );
    const terminalRuns = new Set(request.terminalRunIds);
    const removed: ReapResult['removed'] = [];

    for (const execution of await this.backend.listManaged()) {
      const activeGeneration = activeByRun.get(execution.runId);
      const reason = terminalRuns.has(execution.runId)
        ? 'terminal'
        : Date.parse(execution.deadlineAt) <= now
          ? 'timeout'
          : activeGeneration === undefined
            ? 'orphan'
            : activeGeneration !== execution.generation
              ? activeGeneration > execution.generation
                ? 'stale_generation'
                : 'orphan'
              : undefined;
      if (!reason) continue;
      await this.backend.terminate(execution);
      await this.backend.remove(execution);
      removed.push({
        runId: execution.runId,
        generation: execution.generation,
        reason
      });
    }
    await this.backend.reapInfrastructureOrphans();
    return { removed };
  }

  private async launchExclusive(
    request: RunLaunchRequest
  ): Promise<BackendHandle> {
    const executions = (await this.backend.listManaged()).filter(
      (execution) => execution.runId === request.runId
    );
    const newest = executions.reduce<BackendInspection | undefined>(
      (candidate, execution) =>
        !candidate || execution.generation > candidate.generation
          ? execution
          : candidate,
      undefined
    );
    if (newest && newest.generation > request.generation) {
      throw new StaleGenerationError(
        request.runId,
        request.generation,
        newest.generation
      );
    }
    const matching = executions.find(
      (execution) => execution.generation === request.generation
    );
    if (matching) return matching;

    // A new generation may start only after every older Worker is stopped and gone.
    for (const execution of executions) {
      await this.backend.terminate(execution);
      await this.backend.remove(execution);
    }
    return this.backend.launch(request);
  }

  private async findExact(
    runId: string,
    generation: number
  ): Promise<BackendHandle> {
    const execution = (await this.backend.listManaged()).find(
      (candidate) =>
        candidate.runId === runId && candidate.generation === generation
    );
    if (!execution) throw new ExecutionNotFoundError(runId, generation);
    return execution;
  }
}
