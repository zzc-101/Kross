import type { LlmMessage } from '../llm/types';

/** 每条消息的固定结构开销（角色、分隔符等） */
export const MESSAGE_OVERHEAD_TOKENS = 4;

const CJK_REGEX =
  /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;

function isCjk(char: string): boolean {
  return CJK_REGEX.test(char);
}

/**
 * 启发式文本 token 估算：ASCII ~4 字符/token，CJK ~1 字符/token。
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let tokens = 0;
  for (const char of text) {
    tokens += isCjk(char) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * 单条 LLM 消息 token 估算，含 toolCalls JSON 与 tool 消息全文。
 */
export function estimateMessageTokens(message: LlmMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  if (message.role === 'tool') {
    tokens += estimateTextTokens(message.content);
    tokens += estimateTextTokens(message.name);
    tokens += estimateTextTokens(message.toolCallId);
    return tokens;
  }

  tokens += estimateTextTokens(message.content);
  if (message.toolCalls && message.toolCalls.length > 0) {
    tokens += estimateTextTokens(JSON.stringify(message.toolCalls));
  }
  return tokens;
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export interface TokenEstimatorOptions {
  minFactor?: number;
  maxFactor?: number;
  emaAlpha?: number;
}

/**
 * 带 EMA 校准的 token 估算器。
 * 每次模型响应后用 usage.inputTokens 校准，顶栏与治理阈值共用同一系数。
 */
export class TokenEstimator {
  private calibrationFactor = 1;
  private readonly minFactor: number;
  private readonly maxFactor: number;
  private readonly emaAlpha: number;

  constructor(options: TokenEstimatorOptions = {}) {
    this.minFactor = options.minFactor ?? 0.5;
    this.maxFactor = options.maxFactor ?? 2.0;
    this.emaAlpha = options.emaAlpha ?? 0.3;
  }

  estimate(messages: LlmMessage[]): number {
    const raw = estimateMessagesTokens(messages);
    return Math.max(0, Math.round(raw * this.calibrationFactor));
  }

  estimateMessage(message: LlmMessage): number {
    return Math.max(
      0,
      Math.round(estimateMessageTokens(message) * this.calibrationFactor)
    );
  }

  estimateText(text: string): number {
    return Math.max(
      0,
      Math.round(estimateTextTokens(text) * this.calibrationFactor)
    );
  }

  /**
   * 用真实 inputTokens 更新 EMA 校准系数。
   */
  calibrate(estimatedTokens: number, actualInputTokens: number): void {
    if (estimatedTokens <= 0 || actualInputTokens <= 0) {
      return;
    }
    const ratio = actualInputTokens / estimatedTokens;
    const next =
      this.calibrationFactor * (1 - this.emaAlpha) + ratio * this.emaAlpha;
    this.calibrationFactor = clamp(next, this.minFactor, this.maxFactor);
  }

  resetCalibration(): void {
    this.calibrationFactor = 1;
  }

  getCalibrationFactor(): number {
    return this.calibrationFactor;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
