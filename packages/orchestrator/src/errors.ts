export class OrchestratorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 500
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export class ForbiddenError extends OrchestratorError {
  constructor() {
    super('FORBIDDEN', '服务身份没有执行该操作的权限', 403);
  }
}

export class StaleGenerationError extends OrchestratorError {
  constructor(runId: string, requested: number, current: number) {
    super(
      'STALE_RUN_GENERATION',
      `Run ${runId} generation ${requested} 已落后于 ${current}`,
      409
    );
  }
}

export class ExecutionNotFoundError extends OrchestratorError {
  constructor(runId: string, generation: number) {
    super(
      'EXECUTION_NOT_FOUND',
      `未找到 Run ${runId} generation ${generation} 的执行容器`,
      404
    );
  }
}
