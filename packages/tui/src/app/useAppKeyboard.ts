import { useInput } from 'ink';

import type { PendingToolApproval } from '@kross/core';

import type { SlashCommand } from '../ui';
import type { ModelSettingsState } from '../ui';

export interface UseAppKeyboardOptions {
  requestExit: () => void;
  toggleModelSettings: () => void;
  pendingToolApproval: PendingToolApproval | undefined;
  modelSettings: ModelSettingsState | undefined;
  handleModelSettingsKey: (key: {
    escape?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    return?: boolean;
  }) => boolean;
  toggleLastCollapsible: () => void;
  toggleLastToolGroup: () => void;
  isHome: boolean;
  selectedRecentSession: number | undefined;
  setSelectedRecentSession: React.Dispatch<React.SetStateAction<number | undefined>>;
  input: string;
  recentSessionsLength: number;
  rows: number;
  scrollBy: (delta: number) => void;
  cyclePermissionMode: () => void;
  approvalSelection: 'approve' | 'reject';
  setApprovalSelection: React.Dispatch<React.SetStateAction<'approve' | 'reject'>>;
  chooseToolApproval: (approved: boolean) => Promise<void>;
  slashSuggestions: SlashCommand[];
  slashSelectedIndex: number;
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setInput: React.Dispatch<React.SetStateAction<string>>;
}

export function useAppKeyboard({
  requestExit,
  toggleModelSettings,
  pendingToolApproval,
  modelSettings,
  handleModelSettingsKey,
  toggleLastCollapsible,
  toggleLastToolGroup,
  isHome,
  selectedRecentSession,
  setSelectedRecentSession,
  input,
  recentSessionsLength,
  rows,
  scrollBy,
  cyclePermissionMode,
  approvalSelection,
  setApprovalSelection,
  chooseToolApproval,
  slashSuggestions,
  slashSelectedIndex,
  setSlashSelectedIndex,
  setInput
}: UseAppKeyboardOptions): void {
  useInput((inputKey, key) => {
    if (key.ctrl && inputKey.toLowerCase() === 'c') {
      requestExit();
      return;
    }

    // ctrl+p：打开/关闭模型与思考强度面板
    if (key.ctrl && inputKey.toLowerCase() === 'p') {
      toggleModelSettings();
      return;
    }

    // 模型设置面板优先接管导航键
    if (modelSettings) {
      if (handleModelSettingsKey(key)) {
        return;
      }
    }

    // ctrl+o：切换最近一条 thinking 的折叠/展开（审批中也可用）
    if (key.ctrl && inputKey.toLowerCase() === 'o') {
      toggleLastCollapsible();
      return;
    }

    // ctrl+e：展开/折叠最近一条工具组（如 Read 5 files 明细）
    if (key.ctrl && inputKey.toLowerCase() === 'e') {
      toggleLastToolGroup();
      return;
    }

    // 最近会话一旦选中，Esc 始终优先取消；即使用户已经开始输入也不例外。
    if (isHome && key.escape && selectedRecentSession !== undefined) {
      setSelectedRecentSession(undefined);
      return;
    }

    // 首页输入为空时，方向键只切换最近会话；Enter 仍交给 Composer 提交恢复。
    if (isHome && input.trim().length === 0 && recentSessionsLength > 0) {
      if (key.upArrow) {
        setSelectedRecentSession((current) =>
          current === undefined || current <= 0
            ? recentSessionsLength - 1
            : current - 1
        );
        return;
      }
      if (key.downArrow) {
        setSelectedRecentSession((current) =>
          current === undefined || current >= recentSessionsLength - 1
            ? 0
            : current + 1
        );
        return;
      }
    }

    // 消息视口滚动：PgUp/PgDn，或 ctrl+↑/↓（钳制在可滚动范围内）
    if (!pendingToolApproval) {
      const step = Math.max(3, Math.floor(rows / 4));
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        scrollBy(step);
        return;
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        scrollBy(-step);
        return;
      }
    }

    if (key.shift && key.tab && !pendingToolApproval) {
      cyclePermissionMode();
      return;
    }

    if (pendingToolApproval) {
      if (key.leftArrow || key.rightArrow || inputKey.toLowerCase() === 'tab') {
        setApprovalSelection((current) => (current === 'approve' ? 'reject' : 'approve'));
        return;
      }
      if (inputKey.toLowerCase() === 'a') {
        void chooseToolApproval(true);
        return;
      }
      if (inputKey.toLowerCase() === 'r') {
        void chooseToolApproval(false);
        return;
      }
      if (key.return) {
        void chooseToolApproval(approvalSelection === 'approve');
      }
      return;
    }

    if (slashSuggestions.length === 0) {
      return;
    }

    if (key.escape) {
      setInput('');
      return;
    }

    if (key.upArrow) {
      setSlashSelectedIndex((current) =>
        current <= 0 ? slashSuggestions.length - 1 : current - 1
      );
      return;
    }

    if (key.downArrow) {
      setSlashSelectedIndex((current) =>
        current >= slashSuggestions.length - 1 ? 0 : current + 1
      );
      return;
    }

    if (key.tab) {
      const selected = slashSuggestions[slashSelectedIndex] ?? slashSuggestions[0];
      if (selected) {
        setInput(`${selected.name} `);
      }
      return;
    }
  });
}
