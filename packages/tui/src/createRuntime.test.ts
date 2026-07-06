import { describe, expect, it } from 'vitest';

import { OpenAiProtocolClient } from '@kross/core';
import { createRuntimeOptionsFromEnv } from './createRuntime';

describe('createRuntimeOptionsFromEnv', () => {
  it('wires trace store and optional OpenAI-compatible LLM client', () => {
    const options = createRuntimeOptionsFromEnv('/tmp/local-agent', {
      AGENT_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'key',
      OPENAI_MODEL: 'gpt-test'
    });

    expect(options.traceStore).toBeDefined();
    expect(options.llmClient).toBeInstanceOf(OpenAiProtocolClient);
  });

  it('omits LLM client when provider env is not configured', () => {
    const options = createRuntimeOptionsFromEnv('/tmp/local-agent', {});

    expect(options.traceStore).toBeDefined();
    expect(options.llmClient).toBeUndefined();
  });
});
