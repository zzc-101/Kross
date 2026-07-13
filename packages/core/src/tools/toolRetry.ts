import { ToolBoundaryError } from './builtin/paths';

/** 含首次执行；maxAttempts=1 表示不重试。 */
export interface ToolRetryPolicy {
  maxAttempts: number;
  /** 第 1 次失败后的等待；之后按 multiplier 递增。 */
  backoffMs?: number;
  backoffMultiplier?: number;
  /** 返回 false 则立即失败，不再重试。 */
  retryOn?: (error: unknown, attempt: number) => boolean;
}

export interface ResolvedToolRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  retryOn: (error: unknown, attempt: number) => boolean;
}

export interface ToolAttemptFailure {
  attempt: number;
  message: string;
}

/** Gateway 默认：最多 2 次 attempt（失败后再试 1 次）。 */
export const DEFAULT_TOOL_RETRY_POLICY: ResolvedToolRetryPolicy = {
  maxAttempts: 2,
  backoffMs: 200,
  backoffMultiplier: 2,
  retryOn: isRetryableToolError
};

/** Bash 等：仅超时可重试，exit≠0 不走此路径。 */
export const TIMEOUT_ONLY_RETRY_POLICY: ToolRetryPolicy = {
  maxAttempts: 2,
  backoffMs: 200,
  backoffMultiplier: 2,
  retryOn: (error) => isErrorNamed(error, 'ToolTimeoutError')
};

/**
 * 瞬时 / 可恢复错误才重试。
 * 逻辑错误、权限、路径越界、校验失败一律不重试。
 * 用 error.name 判断 Gateway 错误类型，避免与 toolGateway 循环依赖。
 */
export function isRetryableToolError(error: unknown): boolean {
  if (
    isErrorNamed(error, 'ToolValidationError') ||
    isErrorNamed(error, 'ToolPermissionError') ||
    isErrorNamed(error, 'ToolNotFoundError')
  ) {
    return false;
  }
  if (error instanceof ToolBoundaryError) {
    return false;
  }
  if (isErrorNamed(error, 'ToolTimeoutError')) {
    return true;
  }

  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code);
    if (NON_RETRYABLE_ERRNO.has(code)) {
      return false;
    }
    if (RETRYABLE_ERRNO.has(code)) {
      return true;
    }
  }

  // 未分类 Error：有限次重试（默认 maxAttempts 已很小）
  return error instanceof Error;
}

const RETRYABLE_ERRNO = new Set([
  'EAGAIN',
  'EBUSY',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EIO',
  'ENFILE',
  'EMFILE',
  'EAI_AGAIN'
]);

const NON_RETRYABLE_ERRNO = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EPERM',
  'EACCES',
  'EROFS',
  'EINVAL',
  'ENAMETOOLONG',
  'ELOOP'
]);

export function resolveToolRetryPolicy(input: {
  callRetry?: ToolRetryPolicy | false;
  definitionRetry?: ToolRetryPolicy | false;
  gatewayRetry?: ToolRetryPolicy | false;
}): ResolvedToolRetryPolicy {
  if (input.callRetry === false) {
    return noRetryPolicy();
  }
  if (input.definitionRetry === false) {
    return noRetryPolicy();
  }
  if (input.gatewayRetry === false && input.definitionRetry === undefined) {
    return noRetryPolicy();
  }

  const layers: Array<ToolRetryPolicy | undefined> = [];
  if (input.gatewayRetry && input.gatewayRetry !== false) {
    layers.push(input.gatewayRetry);
  }
  if (input.definitionRetry && input.definitionRetry !== false) {
    layers.push(input.definitionRetry);
  }
  if (input.callRetry && input.callRetry !== false) {
    layers.push(input.callRetry);
  }

  let resolved: ResolvedToolRetryPolicy = { ...DEFAULT_TOOL_RETRY_POLICY };
  for (const layer of layers) {
    if (!layer) {
      continue;
    }
    resolved = {
      maxAttempts: Math.max(1, Math.floor(layer.maxAttempts)),
      backoffMs: layer.backoffMs ?? resolved.backoffMs,
      backoffMultiplier: layer.backoffMultiplier ?? resolved.backoffMultiplier,
      retryOn: layer.retryOn ?? resolved.retryOn
    };
  }
  return resolved;
}

export function retryBackoffMs(
  policy: ResolvedToolRetryPolicy,
  failedAttempt: number
): number {
  // failedAttempt 从 1 起：第 1 次失败后 delay = backoffMs
  const exp = Math.max(0, failedAttempt - 1);
  return Math.max(0, Math.round(policy.backoffMs * policy.backoffMultiplier ** exp));
}

export function formatToolFailureObservation(input: {
  toolName: string;
  failures: ToolAttemptFailure[];
  maxAttempts: number;
}): {
  content: string;
  summary: string;
  data: {
    attempts: number;
    maxAttempts: number;
    retried: boolean;
    errors: ToolAttemptFailure[];
  };
} {
  const { toolName, failures, maxAttempts } = input;
  const attempts = failures.length;
  const last = failures[attempts - 1];
  const lastMessage = last?.message ?? 'unknown error';
  const retried = attempts > 1;

  const data = {
    attempts,
    maxAttempts,
    retried,
    errors: failures
  };

  if (!retried) {
    return {
      content: `Tool ${toolName} failed: ${lastMessage}`,
      summary: clipSummary(`failed: ${lastMessage}`),
      data
    };
  }

  const attemptLines = failures
    .map((item) => `${item.attempt}=${item.message}`)
    .join('; ');

  return {
    content: [
      `Tool ${toolName} failed after ${attempts} attempts: ${lastMessage}`,
      `Last error: ${lastMessage}`,
      `Attempts: ${attemptLines}`
    ].join('\n'),
    summary: clipSummary(`failed after ${attempts} attempts: ${lastMessage}`),
    data
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function noRetryPolicy(): ResolvedToolRetryPolicy {
  return {
    maxAttempts: 1,
    backoffMs: 0,
    backoffMultiplier: 1,
    retryOn: () => false
  };
}

function clipSummary(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
