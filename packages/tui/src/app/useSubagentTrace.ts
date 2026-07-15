import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentRuntime } from '@kross/core';

import type { ChatMessage, ToolCallState } from '../ui';
import {
  applySubagentTraceEvent,
  pruneSubagentUi,
  type SubagentUiState
} from './subagentUi';
import { handleTraceEvent } from './traceMessages';

export interface UseSubagentTraceOptions {
  agentRuntime: AgentRuntime;
  append: (from: ChatMessage['from'], text: string) => number;
  upsertToolMessage: (key: string, tool: ToolCallState) => number;
  setLoadingVariant: React.Dispatch<React.SetStateAction<'thinking' | 'tool'>>;
  setAwaitingReply: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingMessageId: React.Dispatch<React.SetStateAction<number | undefined>>;
}

export function useSubagentTrace({
  agentRuntime,
  append,
  upsertToolMessage,
  setLoadingVariant,
  setAwaitingReply,
  setStreamingMessageId
}: UseSubagentTraceOptions) {
  const [subagents, setSubagents] = useState<SubagentUiState[]>([]);
  const [subagentExpanded, setSubagentExpanded] = useState(false);
  const appendRef = useRef(append);
  appendRef.current = append;

  useEffect(() => {
    return agentRuntime.onTrace((event) => {
      setSubagents((current) =>
        pruneSubagentUi(applySubagentTraceEvent(current, event))
      );
      handleTraceEvent(event, {
        upsertToolMessage,
        setLoadingVariant,
        setAwaitingReply,
        setStreamingMessageId,
        appendSystem: (text) => {
          appendRef.current('system', text);
        }
      });
    });
  }, [agentRuntime, upsertToolMessage, setAwaitingReply, setLoadingVariant, setStreamingMessageId]);

  // Prune finished subagent cards (keep ~60s; keep while expanded).
  useEffect(() => {
    if (subagents.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      if (subagentExpanded) {
        return;
      }
      setSubagents((current) => pruneSubagentUi(current));
    }, 5000);
    return () => clearInterval(timer);
  }, [subagents.length, subagentExpanded]);

  const toggleSubagentExpand = useCallback(() => {
    setSubagentExpanded((current) => !current);
  }, []);

  return {
    subagents,
    subagentExpanded,
    setSubagentExpanded,
    toggleSubagentExpand
  };
}
