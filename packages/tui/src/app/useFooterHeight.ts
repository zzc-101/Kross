import { useMemo } from 'react';

import type { PendingToolApproval } from '@kross/core';

import {
  COMPOSER_BOTTOM_GAP,
  COMPOSER_HEIGHT,
  resolveApprovalPanelHeight,
  resolveSlashSuggestHeight,
  resolveSubagentPanelHeight,
  type ModelSettingsState,
  type SlashCommand
} from '../ui';
import type { SubagentUiState } from './subagentUi';

export interface FooterLayoutInput {
  pendingToolApproval: PendingToolApproval | undefined;
  modelSettings: ModelSettingsState | undefined;
  modelSettingsOpen: boolean;
  status: string;
  awaitingReply: boolean;
  subagents: SubagentUiState[];
  subagentExpanded: boolean;
  slashSuggestions: SlashCommand[];
  slashHiddenCount: number;
}

export function useFooterHeight(input: FooterLayoutInput): number {
  const {
    pendingToolApproval,
    modelSettings,
    modelSettingsOpen,
    status,
    awaitingReply,
    subagents,
    subagentExpanded,
    slashSuggestions,
    slashHiddenCount
  } = input;

  return useMemo(() => {
    let h = 0;
    const subH = resolveSubagentPanelHeight(subagents, subagentExpanded);

    if (pendingToolApproval) {
      h += resolveApprovalPanelHeight(pendingToolApproval);
    } else if (modelSettings) {
      const optionRows =
        modelSettings.section === 'effort'
          ? modelSettings.efforts.length
          : Math.max(1, modelSettings.models.length);
      h += 7 + optionRows;
    } else {
      // Composer 本体 3 行；无子代理时底 gap=3，有子代理时 gap=0 并由 sub 条占 1 行
      h += COMPOSER_HEIGHT;
      h += subH > 0 ? 0 : COMPOSER_BOTTOM_GAP;
    }

    if (
      (status === 'responding' || status === 'interrupting') &&
      awaitingReply
    ) {
      h += 2; // ThinkingIndicator
    }

    if (
      !pendingToolApproval &&
      !modelSettingsOpen &&
      slashSuggestions.length > 0
    ) {
      h += resolveSlashSuggestHeight(slashSuggestions, slashHiddenCount);
    }

    // 子代理条始终在 footer 最底（Composer/审批 下方）
    h += subH;

    return h;
  }, [
    pendingToolApproval,
    modelSettings,
    modelSettingsOpen,
    status,
    awaitingReply,
    subagents,
    subagentExpanded,
    slashSuggestions,
    slashHiddenCount
  ]);
}
