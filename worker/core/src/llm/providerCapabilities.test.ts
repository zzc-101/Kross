import { describe, expect, it } from 'vitest';

import {
  capabilitiesForNativeAdapter,
  capabilitiesForPiModel
} from './providerCapabilities';
import { createPiAiModels, resolvePiAiModel } from './piAiModels';

describe('provider capabilities', () => {
  it('derives catalog capabilities without Runtime model-name checks', () => {
    const models = createPiAiModels('openai');
    const catalog = models.getModels('openai')[0]!;
    expect(capabilitiesForPiModel(catalog, 'model-catalog')).toMatchObject({
      version: 1,
      source: 'model-catalog',
      toolCalling: true,
      thinking: catalog.reasoning,
      structuredOutput: false,
      multimodalRead: false
    });
  });

  it('uses conservative adapter capabilities for custom models', () => {
    const models = createPiAiModels('deepseek');
    const custom = resolvePiAiModel(models, 'deepseek', 'private-model');
    expect(capabilitiesForPiModel(custom, 'adapter-default')).toEqual({
      version: 1,
      source: 'adapter-default',
      toolCalling: true,
      thinking: true,
      structuredOutput: false,
      promptCaching: false,
      multimodalRead: false
    });
  });

  it('declares native protocol support at the adapter boundary', () => {
    expect(capabilitiesForNativeAdapter('anthropic')).toMatchObject({
      source: 'adapter-default',
      toolCalling: true,
      thinking: true,
      structuredOutput: false,
      promptCaching: false,
      multimodalRead: false
    });
  });
});
