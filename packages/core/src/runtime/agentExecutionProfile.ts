import type { ContextSource } from '../context/sessionContext';
import type {
  AgentMode,
  AgentResult,
  TraceEvent,
  VerificationReport
} from '../domain';
import { renderPrompt } from '../prompts';
import type { TraceStore } from '../trace/traceStore';
import type { LlmToolCall } from '../llm/types';
import type { ToolMetadata } from '../tools/toolGateway';
import {
  assessVerificationGate,
  identifyRequestedVerificationCommand
} from '../verification';
import type { ToolCallPhaseClassification } from './runPhase';

export type AgentExecutionPromptPhase =
  | 'agent'
  | 'plan'
  | 'conductor-plan'
  | 'conductor-review';

/** Stable construction-time inputs available to profile policy factories. */
export interface AgentExecutionProfileContext {
  workspaceRoot?: string;
  traceStore: TraceStore;
}

/**
 * Prompt input includes the exact Coding prompt that Core would otherwise use.
 * Profiles may preserve it, append a narrow overlay, or replace it completely.
 */
export interface AgentSystemPromptContext {
  phase: AgentExecutionPromptPhase;
  mode: AgentMode;
  sessionMode?: AgentMode;
  workspaceRoot?: string;
  defaultPrompt: string;
}

export interface AgentContextSourceContext {
  phase: AgentExecutionPromptPhase;
  mode: AgentMode;
  sessionMode: AgentMode;
  workspaceRoot?: string;
}

export interface AgentContextSourceOverlay {
  /** Existing source ids to remove after Core refreshes its built-in sources. */
  remove?: string[];
  /** Sources to add or replace by id after built-in source refresh. */
  sources?: ContextSource[];
}

export interface AgentProgressDescriptor {
  label: string;
  phase?: string;
  detail?: string;
  percent?: number;
}

export interface AgentToolCallPolicyContext {
  call: LlmToolCall;
  metadata?: ToolMetadata;
  verificationPending: boolean;
  defaultClassification: ToolCallPhaseClassification;
}

/** Narrow overlay; ToolGateway remains the final authorization boundary. */
export interface AgentToolPolicyOverlay {
  /**
   * Subtractive model visibility filter over ToolGateway.listTools(). It does
   * not register tools or grant authority; ToolGateway remains authoritative.
   */
  isToolVisible?(tool: ToolMetadata): boolean;
  /** Emit Coding-specific run.verification.* lifecycle observations. */
  observeCodingVerificationLifecycle?: boolean;
  /** Override semantic phase/classification without changing tool authority. */
  classifyToolCall?(
    context: AgentToolCallPolicyContext
  ): ToolCallPhaseClassification;
}

export type AgentCompletionStatus =
  | 'passed'
  | 'failed'
  | 'not-run'
  | 'not-needed';

export interface AgentCompletionAssessment {
  required: boolean;
  satisfied: boolean;
  status: AgentCompletionStatus;
  reason: string;
  evidence?: string[];
  /** Bounded, trace-safe policy details copied to completion lifecycle events. */
  metadata?: Record<string, unknown>;
}

const COMPLETION_METADATA_MAX_DEPTH = 4;
const COMPLETION_METADATA_MAX_KEYS = 24;
const COMPLETION_METADATA_MAX_ARRAY_ITEMS = 24;
const COMPLETION_METADATA_MAX_STRING_CHARS = 500;
const COMPLETION_METADATA_MAX_NODES = 128;

/** Convert untrusted profile metadata into a bounded JSON-safe trace payload. */
export function sanitizeAgentCompletionMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const seen = new WeakSet<object>();
  const sanitized = sanitizeMetadataValue(metadata, 0, seen, {
    remaining: COMPLETION_METADATA_MAX_NODES
  });
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : undefined;
}

export interface AgentCompletionPolicyContext {
  runId: string;
  originalUserInput: string;
  events: TraceEvent[];
  changedFiles: string[];
  traceReadable: boolean;
  knownVerificationCommands: Array<{ command: string; label: string }>;
}

export interface AgentResultPolicyContext
  extends AgentCompletionPolicyContext {
  result: AgentResult;
}

/** Completion gate used by the shared streaming loop and result finalizer. */
export interface AgentCompletionPolicy {
  readonly id: string;
  /** Preserve Coding's historical no-gateway fast path unless explicitly enabled. */
  readonly assessWithoutTools?: boolean;
  /** Prefix for followup/exhausted trace events. */
  readonly eventPrefix?: string;
  assess(
    context: AgentCompletionPolicyContext
  ): AgentCompletionAssessment | Promise<AgentCompletionAssessment>;
  /** Optional profile-specific report decoration after changed files are attached. */
  finalizeResult?(
    context: AgentResultPolicyContext
  ): AgentResult | Promise<AgentResult>;
  buildFollowupPrompt?(assessment: AgentCompletionAssessment): string;
  buildSatisfiedPrompt?(
    assessment: AgentCompletionAssessment
  ): string | undefined;
}

/**
 * Coding-compatibility gate for the current Git-diff Conductor only. It is not
 * a generic review contract. Non-Coding profiles should leave this disabled
 * until Core gains a separate, profile-driven Conductor implementation.
 */
export interface AgentReviewPolicy {
  supportsConductor: boolean;
  unsupportedReason?: string;
}

export interface AgentExecutionProfile {
  readonly id: string;
  buildSystemPrompt(context: AgentSystemPromptContext): string;
  createCompletionPolicy(
    context: AgentExecutionProfileContext
  ): AgentCompletionPolicy;
  createReviewPolicy?(
    context: AgentExecutionProfileContext
  ): AgentReviewPolicy;
  getContextSources?(
    context: AgentContextSourceContext
  ): AgentContextSourceOverlay | undefined;
  /** Optional product-facing progress projection over redacted lifecycle events. */
  describeProgress?(event: TraceEvent): AgentProgressDescriptor | undefined;
  /** Optional runtime semantics overlay; it never grants tool permission. */
  getToolPolicy?(
    context: AgentExecutionProfileContext
  ): AgentToolPolicyOverlay;
}

/** Current Coding behavior, expressed as the default execution profile. */
export function createCodingAgentExecutionProfile(): AgentExecutionProfile {
  return {
    id: 'coding',
    buildSystemPrompt: ({ defaultPrompt }) => defaultPrompt,
    createCompletionPolicy: () => createCodingCompletionPolicy(),
    createReviewPolicy: () => ({ supportsConductor: true }),
    describeProgress: () => undefined,
    getToolPolicy: () => ({ observeCodingVerificationLifecycle: true })
  };
}

function createCodingCompletionPolicy(): AgentCompletionPolicy {
  return {
    id: 'coding-verification',
    assessWithoutTools: false,
    eventPrefix: 'run.verification',
    assess: (context) => assessCodingCompletion(context),
    finalizeResult: (context) => finalizeCodingResult(context),
    buildFollowupPrompt: (assessment) =>
      renderPrompt('agent.verification.followup', {
        status: assessment.status,
        reason: assessment.reason
      }),
    buildSatisfiedPrompt: () =>
      'The latest post-mutation verification passed. If the user request is satisfied, stop exploring and return the final answer now. Only call another tool when a concrete unmet requirement remains.'
  };
}

function assessCodingCompletion(
  context: AgentCompletionPolicyContext
): AgentCompletionAssessment {
  if (!context.traceReadable) {
    // Preserve the existing safe fallback: unavailable traces must not create
    // an infinite completion loop, while final result decoration stays honest.
    return {
      required: false,
      satisfied: true,
      status: 'not-run',
      reason:
        'Run trace was unavailable, so verification could not be assessed.',
      evidence: []
    };
  }
  const assessment = assessVerificationGate(context.events, {
    changedFiles: context.changedFiles,
    knownCommands: context.knownVerificationCommands,
    requestedCommand: identifyRequestedVerificationCommand(
      context.originalUserInput
    )
  });
  return {
    required: assessment.required,
    satisfied: assessment.satisfied,
    status: assessment.report.status,
    reason: assessment.reason,
    evidence: assessment.report.evidence,
    metadata: {
      lastMutationIndex: assessment.lastMutationIndex,
      requiredKinds: assessment.requiredKinds,
      observedKinds: assessment.observedKinds
    }
  };
}

function finalizeCodingResult(context: AgentResultPolicyContext): AgentResult {
  const requestedCommand = identifyRequestedVerificationCommand(
    context.originalUserInput
  );
  const verification: VerificationReport = context.traceReadable
    ? assessVerificationGate(context.events, {
        changedFiles: context.changedFiles,
        knownCommands: context.knownVerificationCommands,
        requestedCommand
      }).report
    : {
        status: 'not-run',
        commands: [],
        evidence: [],
        reason:
          'Verification evidence could not be collected because the run trace was unavailable.'
      };
  const risks = [...context.result.report.risks];
  if (
    context.result.status === 'completed' &&
    (context.changedFiles.length > 0 || requestedCommand) &&
    verification.status !== 'passed'
  ) {
    risks.push(
      verification.status === 'failed'
        ? '最后一次工作区修改后的验证仍然失败；当前结果不能视为已验证完成'
        : requestedCommand && context.changedFiles.length === 0
          ? `用户明确要求的验证命令（${requestedCommand.label}）没有获得通过证据`
          : '最后一次工作区修改后没有可信的验证通过证据；改动仍存在未验证风险'
    );
  }

  return {
    ...context.result,
    report: {
      ...context.result.report,
      verification,
      risks: [...new Set(risks)]
    }
  };
}

function sanitizeMetadataValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: { remaining: number }
): unknown {
  if (budget.remaining <= 0) return '[truncated]';
  budget.remaining -= 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.slice(0, COMPLETION_METADATA_MAX_STRING_CHARS);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (depth >= COMPLETION_METADATA_MAX_DEPTH) return '[truncated]';
  if (!value || typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, COMPLETION_METADATA_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeMetadataValue(item, depth + 1, seen, budget))
      .filter((item) => item !== undefined);
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(
    0,
    COMPLETION_METADATA_MAX_KEYS
  )) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      continue;
    }
    const sanitized = sanitizeMetadataValue(child, depth + 1, seen, budget);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}
