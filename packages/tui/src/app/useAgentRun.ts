import { useCallback } from 'react';

import {
  t,
  type AgentMode,
  type AgentRuntime,
  type AgentResult,
  type PendingToolApproval
} from '@kross/core';

import { defaultApprovalSelection, type ChatMessage } from '../ui';
import { consumeAgentStream } from './agentStreamConsumer';
import { appendApprovalResult } from './traceMessages';

export interface UseAgentRunOptions {
  agentRuntime: AgentRuntime;
  mode: AgentMode;
  append: (from: ChatMessage['from'], text: string) => number;
  enqueueMessageUpdate: (id: number, text: string) => void;
  flushMessageUpdates: () => void;
  finalizeThinkingDurations: () => void;
  toolMessageIdsRef: React.MutableRefObject<Map<string, number>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setAwaitingReply: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingVariant: React.Dispatch<React.SetStateAction<'thinking' | 'tool'>>;
  setStreamingMessageId: React.Dispatch<React.SetStateAction<number | undefined>>;
  setPendingToolApproval: React.Dispatch<
    React.SetStateAction<PendingToolApproval | undefined>
  >;
  setApprovalSelection: React.Dispatch<React.SetStateAction<'approve' | 'reject'>>;
  setPendingCrossRepoPlan: React.Dispatch<
    React.SetStateAction<{ prompt: string; mode: AgentMode } | undefined>
  >;
  pendingToolApproval: PendingToolApproval | undefined;
  pendingCrossRepoPlan: { prompt: string; mode: AgentMode } | undefined;
  processingRef: React.MutableRefObject<boolean>;
}

export function useAgentRun({
  agentRuntime,
  mode,
  append,
  enqueueMessageUpdate,
  flushMessageUpdates,
  finalizeThinkingDurations,
  toolMessageIdsRef,
  setStatus,
  setAwaitingReply,
  setLoadingVariant,
  setStreamingMessageId,
  setPendingToolApproval,
  setApprovalSelection,
  setPendingCrossRepoPlan,
  pendingToolApproval,
  pendingCrossRepoPlan,
  processingRef
}: UseAgentRunOptions) {
  const runTurn = useCallback(async (
    prompt: string,
    options: { planApproved?: boolean; requestedMode?: AgentMode } = {}
  ) => {
    setStatus('responding');
    setAwaitingReply(true);
    setLoadingVariant('thinking');
    setStreamingMessageId(undefined);
    // 新 run 清空工具卡片索引，避免跨 run 串卡
    toolMessageIdsRef.current.clear();

    let sawAgentText = false;
    let result: AgentResult | undefined;

    try {
      const streamResult = await consumeAgentStream(
        agentRuntime.runStreaming({
          input: prompt,
          requestedMode: options.requestedMode ?? mode,
          approvals: { plan: options.planApproved === true }
        }),
        {
          append,
          enqueueMessageUpdate,
          flushMessageUpdates,
          finalizeThinkingDurations,
          setAwaitingReply,
          setLoadingVariant,
          setStreamingMessageId
        }
      );
      sawAgentText = streamResult.sawAgentText;
      result = streamResult.result;
    } catch (error) {
      flushMessageUpdates();
      finalizeThinkingDurations();
      append(
        'system',
        t('app.runError', {
          error: error instanceof Error ? error.message : String(error)
        })
      );
      setStatus('ready');
      setAwaitingReply(false);
      setStreamingMessageId(undefined);
      return;
    }

    if (!result) {
      flushMessageUpdates();
      finalizeThinkingDurations();
      setStatus('ready');
      setStreamingMessageId(undefined);
      return;
    }

    if (result.mode === 'cross-repo' && result.status === 'cancelled') {
      setStatus('waiting-approval');
      setPendingCrossRepoPlan({ prompt, mode: options.requestedMode ?? mode });
      append('system', t('app.crossRepoPaused'));
      return;
    }

    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection(defaultApprovalSelection(result.pendingApproval.risk));
      append('system', result.summary);
      finalizeThinkingDurations();
      return;
    }

    // 已按 turn 流式写入气泡时，不要用跨轮拼接的 fullText 覆盖最后一条
    if (!sawAgentText && result.summary.trim().length > 0) {
      append('agent', result.summary);
    }
    finalizeThinkingDurations();
    setStatus('ready');
  }, [
    agentRuntime,
    append,
    enqueueMessageUpdate,
    finalizeThinkingDurations,
    flushMessageUpdates,
    mode,
    setApprovalSelection,
    setAwaitingReply,
    setLoadingVariant,
    setPendingCrossRepoPlan,
    setPendingToolApproval,
    setStatus,
    setStreamingMessageId,
    toolMessageIdsRef
  ]);

  const chooseToolApproval = useCallback(async (approved: boolean) => {
    if (!pendingToolApproval) {
      return;
    }

    setStatus('responding');
    setAwaitingReply(true);
    setLoadingVariant('tool');
    setStreamingMessageId(undefined);
    setPendingToolApproval(undefined);
    append(
      'system',
      approved
        ? t('app.toolApproved', { tool: pendingToolApproval.toolName })
        : t('app.toolRejected', { tool: pendingToolApproval.toolName })
    );

    // 与首轮 runTurn 相同：审批后续也走 stream，避免 complete() 整包倾倒。
    // （shift+tab 改权限与是否流式无关；旧路径 resolveToolApproval 固定非流式。）
    let sawAgentText = false;
    let result: AgentResult | undefined;

    try {
      const streamResult = await consumeAgentStream(
        agentRuntime.resolveToolApprovalStreaming({
          runId: pendingToolApproval.runId,
          approved
        }),
        {
          append,
          enqueueMessageUpdate,
          flushMessageUpdates,
          setAwaitingReply,
          setLoadingVariant,
          setStreamingMessageId
        }
      );
      sawAgentText = streamResult.sawAgentText;
      result = streamResult.result;
    } catch (error) {
      flushMessageUpdates();
      append(
        'system',
        t('app.approvalError', {
          error: error instanceof Error ? error.message : String(error)
        })
      );
      setStatus('ready');
      setAwaitingReply(false);
      setStreamingMessageId(undefined);
      return;
    }

    if (!result) {
      flushMessageUpdates();
      setStatus('ready');
      setStreamingMessageId(undefined);
      return;
    }

    // 模型可能在同一轮里继续请求其他高风险工具，需要再次进入审批。
    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setAwaitingReply(false);
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection(defaultApprovalSelection(result.pendingApproval.risk));
      append('system', result.summary);
      return;
    }

    // 已流式写入则勿再整包 append
    if (!sawAgentText) {
      appendApprovalResult(append, result);
    }
    setAwaitingReply(false);
    setStatus('ready');
  }, [
    agentRuntime,
    append,
    enqueueMessageUpdate,
    flushMessageUpdates,
    pendingToolApproval,
    setApprovalSelection,
    setAwaitingReply,
    setLoadingVariant,
    setPendingToolApproval,
    setStatus,
    setStreamingMessageId
  ]);

  const choosePlanApproval = useCallback(async (approved: boolean) => {
    if (!pendingCrossRepoPlan) {
      append('system', t('app.noCrossRepoPlan'));
      return;
    }

    const pending = pendingCrossRepoPlan;
    setPendingCrossRepoPlan(undefined);

    if (!approved) {
      setStatus('ready');
      append('system', t('app.crossRepoCancelled'));
      return;
    }

    append('system', t('app.crossRepoConfirmed'));
    processingRef.current = true;
    try {
      await runTurn(pending.prompt, {
        planApproved: true,
        requestedMode: pending.mode
      });
    } finally {
      processingRef.current = false;
    }
  }, [append, pendingCrossRepoPlan, processingRef, runTurn, setPendingCrossRepoPlan, setStatus]);

  return {
    runTurn,
    chooseToolApproval,
    choosePlanApproval
  };
}
