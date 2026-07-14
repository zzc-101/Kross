import { useCallback, useEffect, useState } from 'react';

import type { AgentRuntime } from '@kross/core';

import type { ToolCallState } from '../ui';
import {
  applySubagentTraceEvent,
  pruneSubagentUi,
  type SubagentUiState
} from './subagentUi';
import { handleTraceEvent } from './traceMessages';

export interface UseSubagentTraceOptions {
  agentRuntime: AgentRuntime;
  upsertToolMessage: (key: string, tool: ToolCallState) => number;
  setLoadingVariant: React.Dispatch<React.SetStateAction<'thinking' | 'tool'>>;
  setAwaitingReply: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingMessageId: React.Dispatch<React.SetStateAction<number | undefined>>;
}

export function useSubagentTrace({
  agentRuntime,
  upsertToolMessage,
  setLoadingVariant,
  setAwaitingReply,
  setStreamingMessageId
}: UseSubagentTraceOptions) {
  const [subagents, setSubagents] = useState<SubagentUiState[]>([]);
  const [subagentExpanded, setSubagentExpanded] = useState(false);

  useEffect(() => {
    return agentRuntime.onTrace((event) => {
      setSubagents((current) =>
        pruneSubagentUi(applySubagentTraceEvent(current, event))
      );
      handleTraceEvent(event, {
        upsertToolMessage,
        setLoadingVariant,
        setAwaitingReply,
        setStreamingMessageId
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
