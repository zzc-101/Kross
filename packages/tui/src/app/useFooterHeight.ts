import { useMemo } from 'react';

import type { PendingToolApproval } from '@kross/core';

import {
  COMPOSER_FOOTER_HEIGHT,
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
    if (pendingToolApproval) {
      h += resolveApprovalPanelHeight(pendingToolApproval);
    } else if (modelSettings) {
      // title + tabs + rule + options + border + hint
      const optionRows =
        modelSettings.section === 'effort'
          ? modelSettings.efforts.length
          : Math.max(1, modelSettings.models.length);
      h += 7 + optionRows;
    } else {
      h += COMPOSER_FOOTER_HEIGHT;
    }
    if (
      (status === 'responding' || status === 'interrupting') &&
      awaitingReply
    ) {
      h += 2; // ThinkingIndicator
    }
    h += resolveSubagentPanelHeight(subagents, subagentExpanded);
    if (
      !pendingToolApproval &&
      !modelSettingsOpen &&
      slashSuggestions.length > 0
    ) {
      h += resolveSlashSuggestHeight(slashSuggestions, slashHiddenCount);
    }
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
