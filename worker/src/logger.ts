export interface WorkerLogFields extends Record<string, unknown> {
  conversationId?: string;
  agentId?: string;
  nodeId?: string;
}

export interface WorkerLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  child(fields: WorkerLogFields): WorkerLogger;
}

export function createWorkerLogger(base: WorkerLogFields = {}): WorkerLogger {
  const write = (level: string, message: string, extra: Record<string, unknown> = {}) => {
    const payload = compact({
      '@timestamp': new Date().toISOString(),
      level,
      message,
      service: 'kross-worker',
      ...compact(base),
      ...compact(extra)
    });
    const line = `${JSON.stringify(payload)}\n`;
    if (level === 'ERROR' || level === 'WARN') {
      process.stderr.write(line);
      return;
    }
    process.stdout.write(line);
  };
  return {
    info: (message, extra) => write('INFO', message, extra),
    warn: (message, extra) => write('WARN', message, extra),
    error: (message, extra) => write('ERROR', message, extra),
    child: (fields) => createWorkerLogger({ ...base, ...fields })
  };
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')
  );
}
