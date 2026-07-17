import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AgentMode } from '../domain';
import type { AppLocale, MessageParams } from '../i18n/types';
import type { PromptKey } from './promptCatalog';
import {
  AGENT_EXECUTION_PROMPT_KEYS,
  AGENT_MODE_PROMPT_KEYS,
  MODE_PHASE_PROMPT_KEYS,
  SUBAGENT_MODE_PROMPT_KEYS,
  SUBAGENT_SHARED_PROMPT_KEYS,
  renderAgentExecutionPrompt,
  renderModePhasePrompt,
  renderPrompt,
  renderSubagentExecutionPrompt
} from './promptRenderer';

interface PromptComponentSpec {
  key: PromptKey;
  params?: MessageParams;
  variant?: string;
}

interface PromptSnapshotCase {
  id: string;
  locale: AppLocale;
  components: PromptComponentSpec[];
  render: () => string;
}

const LOCALES = ['zh', 'en'] as const satisfies readonly AppLocale[];
const MAIN_MODES = ['auto', 'plan', 'conductor'] as const satisfies readonly AgentMode[];
const EXPECTED_COMPOSITION_IDS = [
  'zh/main/auto',
  'zh/main/plan',
  'zh/main/conductor',
  'zh/plan/body',
  'zh/conductor/plan',
  'zh/conductor/review',
  'zh/subagent/explore',
  'zh/subagent/general',
  'en/main/auto',
  'en/main/plan',
  'en/main/conductor',
  'en/plan/body',
  'en/conductor/plan',
  'en/conductor/review',
  'en/subagent/explore',
  'en/subagent/general'
] as const;

describe('prompt composition snapshots', () => {
  it('covers every localized main, phase, and subagent composition', () => {
    const ids = buildSnapshotCases().map((snapshotCase) => snapshotCase.id);
    expect(ids).toEqual(EXPECTED_COMPOSITION_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tracks localized mode compositions and their component fingerprints', () => {
    expect(buildPromptSnapshotManifest()).toMatchSnapshot();
  });
});

function buildPromptSnapshotManifest(): {
  compositions: Array<ReturnType<typeof fingerprintComposition>>;
  components: Record<string, ReturnType<typeof fingerprintComponent>>;
} {
  const cases = buildSnapshotCases();
  const components = new Map<string, ReturnType<typeof fingerprintComponent>>();

  for (const snapshotCase of cases) {
    for (const component of snapshotCase.components) {
      const id = componentId(snapshotCase.locale, component);
      components.set(
        id,
        fingerprintComponent(
          renderPrompt(component.key, component.params ?? {}, snapshotCase.locale)
        )
      );
    }
  }

  return {
    compositions: cases.map(fingerprintComposition),
    components: Object.fromEntries(
      [...components.entries()].sort(([left], [right]) => left.localeCompare(right))
    )
  };
}

function buildSnapshotCases(): PromptSnapshotCase[] {
  const cases: PromptSnapshotCase[] = [];

  for (const locale of LOCALES) {
    for (const mode of MAIN_MODES) {
      cases.push({
        id: `${locale}/main/${mode}`,
        locale,
        components: [
          ...AGENT_EXECUTION_PROMPT_KEYS.map((key) => ({ key })),
          { key: AGENT_MODE_PROMPT_KEYS[mode] },
          {
            key: 'agent.execution.modeContext',
            params: { sessionMode: mode, mode },
            variant: `${mode}/${mode}`
          }
        ],
        render: () =>
          renderAgentExecutionPrompt({ sessionMode: mode, mode, locale })
      });
    }

    cases.push(
      modePhaseCase(locale, 'plan/body', 'plan', 'plan.body'),
      modePhaseCase(
        locale,
        'conductor/plan',
        'conductor',
        'conductor.plan'
      ),
      modePhaseCase(
        locale,
        'conductor/review',
        'conductor',
        'conductor.review'
      )
    );

    for (const mode of ['explore', 'general'] as const) {
      cases.push({
        id: `${locale}/subagent/${mode}`,
        locale,
        components: [
          { key: 'subagent.execution' },
          ...SUBAGENT_SHARED_PROMPT_KEYS.map((key) => ({ key })),
          { key: SUBAGENT_MODE_PROMPT_KEYS[mode] }
        ],
        render: () => renderSubagentExecutionPrompt({ mode, locale })
      });
    }
  }

  return cases;
}

function modePhaseCase(
  locale: AppLocale,
  id: string,
  mode: AgentMode,
  phaseKey: PromptKey
): PromptSnapshotCase {
  const phaseOverlayKey: PromptKey | undefined = MODE_PHASE_PROMPT_KEYS[phaseKey];
  return {
    id: `${locale}/${id}`,
    locale,
    components: [
      { key: AGENT_MODE_PROMPT_KEYS[mode] },
      ...(phaseOverlayKey ? [{ key: phaseOverlayKey }] : []),
      { key: phaseKey }
    ],
    render: () => renderModePhasePrompt(phaseKey, mode, locale)
  };
}

function fingerprintComposition(snapshotCase: PromptSnapshotCase): {
  id: string;
  components: string[];
  chars: number;
  lines: number;
  sha256: string;
  firstLine: string;
  lastLine: string;
} {
  return {
    id: snapshotCase.id,
    components: snapshotCase.components.map((component) =>
      componentId(snapshotCase.locale, component)
    ),
    ...fingerprintText(snapshotCase.render())
  };
}

function fingerprintText(value: string): {
  chars: number;
  lines: number;
  sha256: string;
  firstLine: string;
  lastLine: string;
} {
  const normalized = value.replaceAll('\r\n', '\n').trimEnd();
  const lines = normalized.split('\n');
  return {
    chars: normalized.length,
    lines: lines.length,
    sha256: createHash('sha256').update(normalized).digest('hex'),
    firstLine: lines[0] ?? '',
    lastLine: lines.at(-1) ?? ''
  };
}

function fingerprintComponent(value: string): {
  chars: number;
  lines: number;
  sha256: string;
} {
  const { chars, lines, sha256 } = fingerprintText(value);
  return { chars, lines, sha256 };
}

function componentId(locale: AppLocale, component: PromptComponentSpec): string {
  const suffix = component.variant ? `#${component.variant}` : '';
  return `${locale}:${component.key}${suffix}`;
}
