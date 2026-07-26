export class UnsupportedDataVersionError extends Error {
  constructor(
    readonly format: string,
    readonly actualVersion: unknown,
    readonly supportedVersion: number
  ) {
    super(
      `${format} 使用不受支持的数据版本 ${String(actualVersion)}；当前仅支持版本 ${supportedVersion}`
    );
    this.name = 'UnsupportedDataVersionError';
  }
}

export function assertSupportedDataVersion(
  value: unknown,
  options: {
    format: string;
    field?: 'version' | 'schemaVersion';
    supportedVersion: number;
    allowMissing?: boolean;
  }
): void {
  if (!isRecord(value)) {
    return;
  }
  const field = options.field ?? 'version';
  const actual = value[field];
  if (actual === undefined && options.allowMissing) {
    return;
  }
  if (actual !== options.supportedVersion) {
    throw new UnsupportedDataVersionError(
      options.format,
      actual,
      options.supportedVersion
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
