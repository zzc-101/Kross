export type RuntimeErrorSource = 'model' | 'tool' | 'mcp';
export type RuntimeErrorCategory =
  | 'cancelled'
  | 'permission'
  | 'validation'
  | 'not-found'
  | 'timeout'
  | 'authentication'
  | 'rate-limit'
  | 'unavailable'
  | 'protocol'
  | 'unknown';

export interface RuntimeErrorClassification {
  source: RuntimeErrorSource;
  category: RuntimeErrorCategory;
  retryable: boolean;
  recovery: string;
}

/** Shared, secret-safe classification for model, builtin-tool and MCP failures. */
export function classifyRuntimeError(
  error: unknown,
  source: RuntimeErrorSource
): RuntimeErrorClassification {
  const name = error instanceof Error ? error.name : '';
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  const status = readNumber(error, 'status');

  if (
    name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('cancelled')
  ) {
    return result(
      source,
      'cancelled',
      false,
      '该操作已取消；确认仍需执行后重新发起。'
    );
  }
  if (
    name === 'ToolPermissionError' ||
    message.includes('requires approval') ||
    message.includes('denied by policy')
  ) {
    return result(
      source,
      'permission',
      false,
      '检查权限模式；需要时由用户明确批准该调用。'
    );
  }
  if (name === 'ToolValidationError' || message.includes('invalid input')) {
    return result(source, 'validation', false, '修正调用参数后再试，不要原样重放。');
  }
  if (
    name === 'ToolNotFoundError' ||
    (source !== 'model' && message.includes('not found'))
  ) {
    return result(source, 'not-found', false, '刷新可用工具列表并改用当前存在的工具。');
  }
  if (source === 'model' && (status === 404 || message.includes('not found'))) {
    return result(
      source,
      'not-found',
      false,
      '检查模型名称、Provider 和 base URL 配置。'
    );
  }
  if (
    name === 'ToolTimeoutError' ||
    status === 408 ||
    message.includes('timed out') ||
    message.includes('timeout')
  ) {
    return result(
      source,
      'timeout',
      true,
      '确认外部服务或进程状态，退避后有限重试。'
    );
  }
  if (
    status === 401 ||
    status === 403 ||
    message.includes('api key') ||
    message.includes('unauthorized')
  ) {
    return result(
      source,
      'authentication',
      false,
      '检查凭据、base URL 和服务权限。'
    );
  }
  if (status === 429 || message.includes('rate limit')) {
    return result(source, 'rate-limit', true, '按服务端建议退避后有限重试。');
  }
  if (
    (status !== undefined && status >= 500) ||
    message.includes('not running') ||
    message.includes('closed')
  ) {
    return result(
      source,
      'unavailable',
      true,
      '检查服务进程或网络连通性，恢复后有限重试。'
    );
  }
  if (
    source === 'mcp' ||
    message.includes('protocol') ||
    message.includes('json-rpc')
  ) {
    return result(
      source,
      'protocol',
      false,
      '检查 MCP 服务版本、传输和返回结构后再试。'
    );
  }
  return result(source, 'unknown', false, '保留原始错误证据，调整策略或配置后再试。');
}

function result(
  source: RuntimeErrorSource,
  category: RuntimeErrorCategory,
  retryable: boolean,
  recovery: string
): RuntimeErrorClassification {
  return { source, category, retryable, recovery };
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' ? candidate : undefined;
}
