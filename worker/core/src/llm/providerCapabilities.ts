import type { Api, Model } from '@earendil-works/pi-ai';

export const LLM_CAPABILITIES_VERSION = 1;

export interface LlmCapabilities {
  version: typeof LLM_CAPABILITIES_VERSION;
  source: 'model-catalog' | 'adapter-default';
  toolCalling: boolean;
  thinking: boolean;
  structuredOutput: boolean;
  promptCaching: boolean;
  multimodalRead: boolean;
}

/**
 * Resolve end-to-end Kross capabilities at the provider adapter boundary.
 * Runtime code consumes this declaration and never infers support from model ids.
 */
export function capabilitiesForPiModel(
  model: Model<Api>,
  source: LlmCapabilities['source']
): LlmCapabilities {
  return {
    version: LLM_CAPABILITIES_VERSION,
    source,
    toolCalling: supportsToolCalling(model.api),
    thinking: model.reasoning,
    // Kross does not expose a structured response request contract yet.
    structuredOutput: false,
    promptCaching:
      model.api === 'anthropic-messages' ||
      model.api === 'openai-responses',
    multimodalRead:
      source === 'model-catalog' && modelSupportsImageInput(model)
  };
}

function modelSupportsImageInput(model: Model<Api>): boolean {
  return model.input.includes('image');
}

function supportsToolCalling(api: Api): boolean {
  return (
    api === 'anthropic-messages' ||
    api === 'openai-completions' ||
    api === 'openai-responses'
  );
}
