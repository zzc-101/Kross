import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

export const providerIdSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'deepseek',
  'xai'
]);

export type ProviderId = z.infer<typeof providerIdSchema>;

const savedProviderSchema = z.object({
  version: z.literal(1),
  provider: providerIdSchema,
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1)
});

export const providerUpdateSchema = z.object({
  provider: providerIdSchema,
  model: z.string().trim().min(1).max(200),
  baseUrl: z.union([z.string().trim().url(), z.literal('')]).optional(),
  apiKey: z.string().trim().min(1).optional()
});

export interface PublicProviderConfig {
  provider?: ProviderId;
  model?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  source: 'saved' | 'environment' | 'none';
}

const PROVIDERS: Record<ProviderId, {
  apiKey: string;
  model: string;
  baseUrl: string;
}> = {
  openai: {
    apiKey: 'OPENAI_API_KEY',
    model: 'OPENAI_MODEL',
    baseUrl: 'OPENAI_BASE_URL'
  },
  anthropic: {
    apiKey: 'ANTHROPIC_API_KEY',
    model: 'ANTHROPIC_MODEL',
    baseUrl: 'ANTHROPIC_BASE_URL'
  },
  openrouter: {
    apiKey: 'OPENROUTER_API_KEY',
    model: 'OPENROUTER_MODEL',
    baseUrl: 'OPENROUTER_BASE_URL'
  },
  deepseek: {
    apiKey: 'DEEPSEEK_API_KEY',
    model: 'DEEPSEEK_MODEL',
    baseUrl: 'DEEPSEEK_BASE_URL'
  },
  xai: {
    apiKey: 'XAI_API_KEY',
    model: 'XAI_MODEL',
    baseUrl: 'XAI_BASE_URL'
  }
};

export class RuntimeConfigStore {
  private saved?: z.infer<typeof savedProviderSchema>;

  constructor(
    private readonly path: string,
    private readonly environment: Record<string, string | undefined> = process.env
  ) {
    this.load();
  }

  publicProvider(): PublicProviderConfig {
    if (this.saved) {
      return {
        provider: this.saved.provider,
        model: this.saved.model,
        baseUrl: this.saved.baseUrl,
        hasApiKey: true,
        source: 'saved'
      };
    }
    const explicit = providerIdSchema.safeParse(
      this.environment.AGENT_LLM_PROVIDER
    );
    const inferred = explicit.success
      ? explicit.data
      : (Object.keys(PROVIDERS) as ProviderId[]).find((candidate) => {
          const names = PROVIDERS[candidate];
          return Boolean(this.environment[names.apiKey]);
        });
    if (!inferred) {
      return { hasApiKey: false, source: 'none' };
    }
    const names = PROVIDERS[inferred];
    return {
      provider: inferred,
      model:
        this.environment.AGENT_LLM_MODEL ??
        this.environment[names.model],
      baseUrl: this.environment[names.baseUrl],
      hasApiKey: Boolean(
        this.environment[names.apiKey] ||
        (inferred === 'anthropic' &&
          this.environment.ANTHROPIC_AUTH_TOKEN)
      ),
      source: 'environment'
    };
  }

  workerEnvironment(): Record<string, string | undefined> {
    if (!this.saved) return { ...this.environment };
    const names = PROVIDERS[this.saved.provider];
    return {
      ...this.environment,
      AGENT_LLM_PROVIDER: this.saved.provider,
      AGENT_LLM_MODEL: this.saved.model,
      [names.apiKey]: this.saved.apiKey,
      [names.model]: this.saved.model,
      [names.baseUrl]: this.saved.baseUrl
    };
  }

  hasEnvironment(name: string): boolean {
    return Boolean(this.workerEnvironment()[name]);
  }

  update(input: z.infer<typeof providerUpdateSchema>): PublicProviderConfig {
    const parsed = providerUpdateSchema.parse(input);
    const currentApiKey =
      this.saved?.provider === parsed.provider
        ? this.saved.apiKey
        : undefined;
    const apiKey = parsed.apiKey ?? currentApiKey;
    if (!apiKey) {
      throw new Error('首次保存 Provider 时必须填写 API Key');
    }
    this.saved = {
      version: 1,
      provider: parsed.provider,
      model: parsed.model,
      ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      apiKey
    };
    this.persist();
    return this.publicProvider();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = savedProviderSchema.safeParse(
      JSON.parse(readFileSync(this.path, 'utf8'))
    );
    if (!parsed.success) {
      throw new Error(`Provider 配置损坏: ${this.path}`);
    }
    this.saved = parsed.data;
  }

  private persist(): void {
    if (!this.saved) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.saved, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    renameSync(temporary, this.path);
  }
}
