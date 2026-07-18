import {
  cycleThinkingEffort,
  DEFAULT_THINKING_EFFORT,
  formatModelEffortLabel,
  type ThinkingEffort
} from '../llm/thinkingEffort';
import type { LlmClient } from '../llm/types';
import type { AgentRuntimeOptions } from './agentRuntimeTypes';

/** Owns the mutable model binding and user-facing model controls for a session. */
export class ModelSession {
  constructor(
    private readonly options: AgentRuntimeOptions,
    private readonly onClientChange: (client: LlmClient | undefined) => void
  ) {}

  getModelLabel(): string {
    const client = this.options.llmClient;
    return formatModelEffortLabel(
      client?.model,
      client?.thinkingEffort ?? DEFAULT_THINKING_EFFORT
    );
  }

  getThinkingEffort(): ThinkingEffort {
    return this.options.llmClient?.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
  }

  setThinkingEffort(effort: ThinkingEffort): void {
    const client = this.options.llmClient;
    if (!client?.setThinkingEffort) {
      throw new Error('当前 LLM 客户端不支持切换思考强度');
    }
    client.setThinkingEffort(effort);
  }

  cycleThinkingEffort(): ThinkingEffort {
    const next = cycleThinkingEffort(this.getThinkingEffort());
    this.setThinkingEffort(next);
    return next;
  }

  getLlmClient(): LlmClient | undefined {
    return this.options.llmClient;
  }

  setLlmClient(client: LlmClient | undefined): void {
    this.options.llmClient = client;
    this.onClientChange(client);
  }

  setModel(model: string): void {
    const client = this.options.llmClient;
    if (!client?.setModel) {
      throw new Error('当前 LLM 客户端不支持切换模型');
    }
    client.setModel(model);
    // pi-ai catalog models may have different context windows.
    this.onClientChange(client);
  }
}
