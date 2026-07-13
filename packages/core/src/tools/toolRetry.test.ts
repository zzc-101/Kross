import { describe, expect, it } from 'vitest';

import { ToolBoundaryError } from './builtin/paths';
import { ToolTimeoutError, ToolValidationError } from './toolGateway';
import {
  formatToolFailureObservation,
  isRetryableToolError,
  resolveToolRetryPolicy,
  retryBackoffMs
} from './toolRetry';
import { ZodError } from 'zod';

describe('toolRetry', () => {
  it('classifies retryable vs non-retryable errors', () => {
    expect(isRetryableToolError(new ToolTimeoutError('t', 10))).toBe(true);
    expect(isRetryableToolError(new Error('transient'))).toBe(true);

    const busy = new Error('busy') as Error & { code: string };
    busy.code = 'EBUSY';
    expect(isRetryableToolError(busy)).toBe(true);

    const missing = new Error('missing') as Error & { code: string };
    missing.code = 'ENOENT';
    expect(isRetryableToolError(missing)).toBe(false);

    expect(
      isRetryableToolError(
        new ToolValidationError('t', new ZodError([]))
      )
    ).toBe(false);
    expect(isRetryableToolError(new ToolBoundaryError('../x'))).toBe(false);
  });

  it('resolves policy precedence: call > definition > gateway > default', () => {
    const disabled = resolveToolRetryPolicy({ callRetry: false });
    expect(disabled.maxAttempts).toBe(1);

    const custom = resolveToolRetryPolicy({
      gatewayRetry: { maxAttempts: 3, backoffMs: 10 },
      definitionRetry: { maxAttempts: 4 },
      callRetry: { maxAttempts: 5, backoffMs: 1 }
    });
    expect(custom.maxAttempts).toBe(5);
    expect(custom.backoffMs).toBe(1);
  });

  it('computes backoff and formats multi-attempt failure for the model', () => {
    const policy = resolveToolRetryPolicy({
      callRetry: { maxAttempts: 3, backoffMs: 100, backoffMultiplier: 2 }
    });
    expect(retryBackoffMs(policy, 1)).toBe(100);
    expect(retryBackoffMs(policy, 2)).toBe(200);

    const observation = formatToolFailureObservation({
      toolName: 'Read',
      maxAttempts: 2,
      failures: [
        { attempt: 1, message: 'timeout' },
        { attempt: 2, message: 'timeout again' }
      ]
    });
    expect(observation.content).toContain('failed after 2 attempts');
    expect(observation.content).toContain('1=timeout');
    expect(observation.content).toContain('2=timeout again');
    expect(observation.data.retried).toBe(true);
  });
});
