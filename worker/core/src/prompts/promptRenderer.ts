import type { AgentMode } from '../domain';
import {
  getPromptTemplate,
  type PromptKey
} from './promptCatalog';

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

export const AGENT_EXECUTION_PROMPT_KEYS = [
  'agent.execution.base',
  'agent.execution.intent',
  'agent.execution.authority',
  'agent.execution.instructions',
  'agent.execution.workspaceSafety',
  'agent.execution.toolDiscipline',
  'agent.execution.workflow.inspect',
  'agent.execution.workflow.plan',
  'agent.execution.workflow.act',
  'agent.execution.workflow.verify',
  'agent.execution.workflow.recover',
  'agent.execution.completion',
  'agent.execution.communication'
] as const satisfies readonly PromptKey[];

export const AGENT_MODE_PROMPT_KEYS = {
  auto: 'agent.execution.mode.auto',
  plan: 'agent.execution.mode.plan',
  conductor: 'agent.execution.mode.conductor'
} as const satisfies Record<AgentMode, PromptKey>;

export const MODE_PHASE_PROMPT_KEYS: Partial<Record<PromptKey, PromptKey>> = {
  'conductor.plan': 'agent.execution.mode.conductor.plan',
  'conductor.review': 'agent.execution.mode.conductor.review'
};

export const SUBAGENT_SHARED_PROMPT_KEYS = [
  'agent.execution.instructions',
  'agent.execution.workspaceSafety',
  'agent.execution.toolDiscipline',
  'agent.execution.workflow.inspect',
  'agent.execution.workflow.plan',
  'agent.execution.workflow.act',
  'agent.execution.workflow.verify',
  'agent.execution.workflow.recover',
  'agent.execution.completion',
  'agent.execution.communication'
] as const satisfies readonly PromptKey[];

export const SUBAGENT_MODE_PROMPT_KEYS = {
  explore: 'subagent.execution.mode.explore',
  general: 'subagent.execution.mode.general'
} as const satisfies Record<'explore' | 'general', PromptKey>;

export function renderPrompt(
  key: PromptKey,
  params: Record<string, string | number> = {}
): string {
  const template = getPromptTemplate(key);
  const text = Array.isArray(template) ? template.join('\n') : template;

  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing prompt parameter "${name}" for ${key}`);
    }
    return String(value);
  });
}

export function renderAgentExecutionPrompt(input: {
  sessionMode?: string;
  mode?: AgentMode;
} = {}): string {
  const parts = AGENT_EXECUTION_PROMPT_KEYS.map((key) => renderPrompt(key));

  if (input.mode !== undefined) {
    parts.push(renderAgentModeOverlay(input.mode));
  }

  if (input.sessionMode !== undefined) {
    if (input.mode === undefined) {
      throw new Error('mode is required when sessionMode is provided');
    }
    parts.push(
      renderPrompt('agent.execution.modeContext', {
        sessionMode: input.sessionMode,
        mode: input.mode
      })
    );
  }

  return parts.join('\n');
}

export function renderAgentModeOverlay(mode: AgentMode): string {
  return renderPrompt(AGENT_MODE_PROMPT_KEYS[mode]);
}

export function renderModePhasePrompt(
  key: PromptKey,
  mode: AgentMode
): string {
  const phaseOverlayKey: PromptKey | undefined = MODE_PHASE_PROMPT_KEYS[key];
  return [
    renderAgentModeOverlay(mode),
    ...(phaseOverlayKey ? [renderPrompt(phaseOverlayKey)] : []),
    renderPrompt(key)
  ].join('\n');
}

export function renderSubagentExecutionPrompt(input: {
  mode: 'explore' | 'general';
}): string {
  return [
    renderPrompt('subagent.execution'),
    ...SUBAGENT_SHARED_PROMPT_KEYS.map((key) => renderPrompt(key)),
    renderPrompt(SUBAGENT_MODE_PROMPT_KEYS[input.mode])
  ].join('\n');
}
