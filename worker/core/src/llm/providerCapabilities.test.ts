import { describe, expect, it } from 'vitest';

import { capabilitiesForPiModel } from './providerCapabilities';
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
      multimodalRead: catalog.input.includes('image')
    });
  });

  it('enables multimodalRead only when the catalog model accepts images', () => {
    const models = createPiAiModels('openai');
    const withImage = models.getModels('openai').find((model) =>
      model.input.includes('image')
    );
    const textOnly = models.getModels('openai').find(
      (model) => !model.input.includes('image')
    );
    if (withImage) {
      expect(capabilitiesForPiModel(withImage, 'model-catalog').multimodalRead).toBe(
        true
      );
    }
    if (textOnly) {
      expect(capabilitiesForPiModel(textOnly, 'model-catalog').multimodalRead).toBe(
        false
      );
    }
    expect(Boolean(withImage || textOnly)).toBe(true);
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
});
