import { describe, expect, it } from 'vitest';

import { LlmProviderError } from '../llm/types';
import { ToolTimeoutError, ToolValidationError } from '../tools/toolGateway';
import { z } from 'zod';
import { classifyRuntimeError } from './runtimeError';

describe('classifyRuntimeError', () => {
  it('classifies model rate limits with a retry suggestion', () => {
    expect(
      classifyRuntimeError(
        new LlmProviderError('rate limited', 'openai', 429),
        'model'
      )
    ).toMatchObject({ category: 'rate-limit', retryable: true });
  });

  it('classifies tool validation and timeout failures consistently', () => {
    const parsed = z.object({ path: z.string() }).safeParse({});
    if (parsed.success) throw new Error('expected invalid input');
    expect(
      classifyRuntimeError(
        new ToolValidationError('Read', parsed.error),
        'tool'
      )
    ).toMatchObject({ category: 'validation', retryable: false });
    expect(
      classifyRuntimeError(new ToolTimeoutError('Read', 100), 'tool')
    ).toMatchObject({ category: 'timeout', retryable: true });
  });
});
