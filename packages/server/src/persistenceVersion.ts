export class UnsupportedServerDataVersionError extends Error {
  constructor(
    format: string,
    actualVersion: unknown,
    supportedVersion: number
  ) {
    super(
      `${format} 使用不受支持的数据版本 ${String(actualVersion)}；当前仅支持版本 ${supportedVersion}`
    );
    this.name = 'UnsupportedServerDataVersionError';
  }
}

export function assertServerDataVersion(
  value: unknown,
  options: {
    format: string;
    supportedVersion: number;
    allowMissing?: boolean;
  }
): void {
  if (!isRecord(value)) return;
  const actual = value.version;
  if (actual === undefined && options.allowMissing) return;
  if (actual !== options.supportedVersion) {
    throw new UnsupportedServerDataVersionError(
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
