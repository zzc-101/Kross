import {
  getPromptTemplate,
  type PromptKey
} from './promptCatalog';

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

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

export function renderSubagentExecutionPrompt(input: {
  mode: 'explore' | 'general';
}): string {
  return [
    renderPrompt('subagent.execution'),
    ...SUBAGENT_SHARED_PROMPT_KEYS.map((key) => renderPrompt(key)),
    renderPrompt(SUBAGENT_MODE_PROMPT_KEYS[input.mode])
  ].join('\n');
}
