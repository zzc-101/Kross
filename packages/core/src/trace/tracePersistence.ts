import { traceEventSchema, type TraceEvent } from '../domain';
import {
  assertSupportedDataVersion,
  UnsupportedDataVersionError
} from '../persistence/version';

export const TRACE_EVENT_FORMAT_VERSION = 1;

export function serializeTraceEvent(event: TraceEvent): string {
  const parsed = traceEventSchema.parse(event);
  return JSON.stringify({
    schemaVersion: TRACE_EVENT_FORMAT_VERSION,
    ...parsed
  });
}

export function parseStoredTraceEvent(line: string): TraceEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  assertSupportedDataVersion(raw, {
    format: 'Trace event',
    field: 'schemaVersion',
    supportedVersion: TRACE_EVENT_FORMAT_VERSION,
    allowMissing: true
  });
  const parsed = traceEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function isUnsupportedTraceVersion(
  error: unknown
): error is UnsupportedDataVersionError {
  return error instanceof UnsupportedDataVersionError;
}
