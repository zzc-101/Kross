export class UnsupportedWorkerDataVersionError extends Error {
  constructor(
    format: string,
    actualVersion: unknown,
    supportedVersion: number
  ) {
    super(
      `${format} 使用不受支持的数据版本 ${String(actualVersion)}；当前仅支持版本 ${supportedVersion}`
    );
    this.name = 'UnsupportedWorkerDataVersionError';
  }
}

export function assertWorkerDataVersion(
  value: unknown,
  options: {
    format: string;
    field?: 'version' | 'protocolVersion';
    supportedVersion: number;
    allowMissing?: boolean;
  }
): void {
  if (!isRecord(value)) return;
  const actual = value[options.field ?? 'version'];
  if (actual === undefined && options.allowMissing) return;
  if (actual !== options.supportedVersion) {
    throw new UnsupportedWorkerDataVersionError(
      options.format,
      actual,
      options.supportedVersion
    );
  }
}

export function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
