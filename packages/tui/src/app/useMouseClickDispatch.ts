import { useEffect } from 'react';

import type { PendingToolApproval } from '@kross/core';

import { subscribeClick } from '../terminal/mouseTracking';

import {
  hitTestSubagentPanel,
  hitTestTodoToggle,
  resolveSubagentPanelHeight,
  type ChatMessage
} from '../ui';
import {
  hitTestClickableMessage,
  MessagePaintCache,
  resolveViewportContentRows
} from '../ui/messagePaint';

import type { SubagentUiState } from './subagentUi';

export interface UseMouseClickDispatchOptions {
  shellMode: boolean;
  pendingToolApproval: PendingToolApproval | undefined;
  modelSettingsOpen: boolean;
  columns: number;
  contentWidth: number;
  isHome: boolean;
  appError: string | undefined;
  todoCount: number;
  todoExpanded: boolean;
  setTodoExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  subagents: SubagentUiState[];
  subagentExpanded: boolean;
  setSubagentExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  headerHeight: number;
  messageViewportHeight: number;
  messages: ChatMessage[];
  scrollOffset: number;
  streamingMessageId: number | undefined;
  clickPaintCacheRef: React.MutableRefObject<MessagePaintCache>;
  toggleThinkingById: (messageId: number) => void;
  toggleToolById: (messageId: number) => void;
}

export function useMouseClickDispatch({
  shellMode,
  pendingToolApproval,
  modelSettingsOpen,
  columns,
  contentWidth,
  isHome,
  appError,
  todoCount,
  todoExpanded,
  setTodoExpanded,
  subagents,
  subagentExpanded,
  setSubagentExpanded,
  headerHeight,
  messageViewportHeight,
  messages,
  scrollOffset,
  streamingMessageId,
  clickPaintCacheRef,
  toggleThinkingById,
  toggleToolById
}: UseMouseClickDispatchOptions): void {
  // 左键单击：顶栏 Todo / 子代理条展开；消息区 Thought / Tool 折叠
  useEffect(() => {
    return subscribeClick((event) => {
      if (pendingToolApproval || modelSettingsOpen || !shellMode) {
        return;
      }
      if (
        hitTestTodoToggle({
          clickRow: event.row,
          clickCol: event.col,
          columns,
          compact: isHome,
          hasError: Boolean(appError),
          todoCount,
          todoExpanded,
          contentTopRow: 1
        })
      ) {
        setTodoExpanded((current) => !current);
        return;
      }
      // 子代理条在 footer 最底，单行且无展开内容；点击不再 toggle
      const subagentPanelHeight = resolveSubagentPanelHeight(subagents, false);
      if (
        hitTestSubagentPanel({
          clickRow: event.row,
          headerHeight,
          viewportHeight: messageViewportHeight,
          panelHeight: subagentPanelHeight,
          hasSubagents: subagents.length > 0,
          contentTopRow: 1,
          // 粗略：footer 其余部分 = 总 footer 高 − 子代理 1 行（由 App 布局保证）
          footerRowsAbove: Math.max(
            0,
            // 视口下到子代理条上方：由调用方 footer 高度估算时会校准；
            // 无展开需求时误点无副作用，这里用 0 仅避免旧逻辑点到视口
            0
          )
        })
      ) {
        return;
      }
      const { contentRows } = resolveViewportContentRows({
        messages,
        columns: contentWidth,
        viewportRows: messageViewportHeight,
        scrollOffset,
        streamingMessageId,
        paintCache: clickPaintCacheRef.current
      });
      const hit = hitTestClickableMessage({
        messages,
        columns: contentWidth,
        contentRows,
        scrollOffset,
        clickRow: event.row,
        viewportTopRow: headerHeight + 1,
        streamingMessageId,
        paintCache: clickPaintCacheRef.current
      });
      if (!hit) {
        return;
      }
      if (hit.kind === 'thinking') {
        toggleThinkingById(hit.messageId);
      } else {
        toggleToolById(hit.messageId);
      }
    });
  }, [
    pendingToolApproval,
    modelSettingsOpen,
    shellMode,
    headerHeight,
    contentWidth,
    columns,
    isHome,
    appError,
    todoCount,
    todoExpanded,
    subagents,
    subagentExpanded,
    messageViewportHeight,
    scrollOffset,
    messages,
    streamingMessageId,
    toggleThinkingById,
    toggleToolById,
    setTodoExpanded,
    setSubagentExpanded,
    clickPaintCacheRef
  ]);
}
