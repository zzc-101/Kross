import { useCallback, useEffect, useRef } from 'react';

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

export type RunTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'paused';

export interface UseAgentRunOptions {
  agentRuntime: AgentRuntime;
  mode: AgentMode;
  append: (
    from: ChatMessage['from'],
    text: string,
    options?: { expanded?: boolean; durationMs?: number }
  ) => number;
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
  setPendingConductorPlan: React.Dispatch<
    React.SetStateAction<{ prompt: string; mode: AgentMode } | undefined>
  >;
  pendingToolApproval: PendingToolApproval | undefined;
  pendingConductorPlan: { prompt: string; mode: AgentMode } | undefined;
  processingRef: React.MutableRefObject<boolean>;
}

interface ActiveOperation {
  id: number;
  controller: AbortController;
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
  setPendingConductorPlan,
  pendingToolApproval,
  pendingConductorPlan,
  processingRef
}: UseAgentRunOptions) {
  const nextOperationIdRef = useRef(0);
  const activeOperationRef = useRef<ActiveOperation>();
  const interruptingApprovalRunIdRef = useRef<string>();

  const beginOperation = (): ActiveOperation => {
    nextOperationIdRef.current += 1;
    const operation = {
      id: nextOperationIdRef.current,
      controller: new AbortController()
    };
    activeOperationRef.current = operation;
    return operation;
  };

  const finishOperation = (operation: ActiveOperation): void => {
    if (activeOperationRef.current?.id === operation.id) {
      activeOperationRef.current = undefined;
    }
  };

  useEffect(() => {
    return () => {
      const active = activeOperationRef.current;
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(new Error('TUI unmounted'));
      }
    };
  }, []);

  const settleInterruptedUi = useCallback((): RunTurnOutcome => {
    flushMessageUpdates();
    finalizeThinkingDurations();
    append('system', t('app.interrupted'));
    setStatus('ready');
    setAwaitingReply(false);
    setStreamingMessageId(undefined);
    return 'cancelled';
  }, [
    append,
    finalizeThinkingDurations,
    flushMessageUpdates,
    setAwaitingReply,
    setStatus,
    setStreamingMessageId
  ]);

  const runTurn = useCallback(async (
    prompt: string,
    options: { planApproved?: boolean; requestedMode?: AgentMode } = {}
  ): Promise<RunTurnOutcome> => {
    const operation = beginOperation();
    setStatus('responding');
    setAwaitingReply(true);
    setLoadingVariant('thinking');
    setStreamingMessageId(undefined);
    toolMessageIdsRef.current.clear();

    let sawAgentText = false;
    let result: AgentResult | undefined;

    try {
      const streamResult = await consumeAgentStream(
        agentRuntime.runStreaming({
          input: prompt,
          requestedMode: options.requestedMode ?? mode,
          approvals: { plan: options.planApproved === true },
          signal: operation.controller.signal
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
      if (operation.controller.signal.aborted) {
        return settleInterruptedUi();
      }
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
      return 'failed';
    } finally {
      finishOperation(operation);
    }

    if (!result) {
      flushMessageUpdates();
      finalizeThinkingDurations();
      setStatus('ready');
      setAwaitingReply(false);
      setStreamingMessageId(undefined);
      return 'failed';
    }

    if (
      result.status === 'cancelled' &&
      result.cancellationReason === 'user-interrupt'
    ) {
      return settleInterruptedUi();
    }

    if (
      result.status === 'cancelled' &&
      result.cancellationReason === 'approval-gate' &&
      (result.mode === 'conductor' || result.mode === 'plan')
    ) {
      setStatus('waiting-approval');
      setPendingConductorPlan({ prompt, mode: result.mode });
      // 已流式打出计划正文则不再整段 append，避免重复
      if (!sawAgentText) {
        if (result.summary.trim().length > 0) {
          append('agent', result.summary);
        } else {
          append(
            'system',
            result.mode === 'plan' ? t('app.planPaused') : t('app.conductorPaused')
          );
        }
      }
      finalizeThinkingDurations();
      setAwaitingReply(false);
      return 'paused';
    }

    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setAwaitingReply(false);
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection(defaultApprovalSelection(result.pendingApproval.risk));
      append('system', result.summary);
      finalizeThinkingDurations();
      return 'paused';
    }

    if (!sawAgentText && result.summary.trim().length > 0) {
      append('agent', result.summary);
    }
    finalizeThinkingDurations();
    setAwaitingReply(false);
    setStatus('ready');
    return result.status === 'failed' ? 'failed' : 'completed';
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
    setPendingConductorPlan,
    setPendingToolApproval,
    setStatus,
    setStreamingMessageId,
    settleInterruptedUi,
    toolMessageIdsRef
  ]);

  const chooseToolApproval = useCallback(async (approved: boolean) => {
    if (!pendingToolApproval) {
      return;
    }

    // 清掉审批面板前先锁提交，避免 open-turn 收口前并发 beginTurn。
    processingRef.current = true;
    const operation = beginOperation();
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

    let sawAgentText = false;
    let result: AgentResult | undefined;

    try {
      const streamResult = await consumeAgentStream(
        agentRuntime.resolveToolApprovalStreaming({
          runId: pendingToolApproval.runId,
          approved,
          signal: operation.controller.signal
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
      if (operation.controller.signal.aborted) {
        settleInterruptedUi();
        return;
      }
      flushMessageUpdates();
      finalizeThinkingDurations();
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
    } finally {
      finishOperation(operation);
      processingRef.current = false;
    }

    if (!result) {
      flushMessageUpdates();
      finalizeThinkingDurations();
      setStatus('ready');
      setAwaitingReply(false);
      setStreamingMessageId(undefined);
      return;
    }

    if (
      result.status === 'cancelled' &&
      result.cancellationReason === 'user-interrupt'
    ) {
      settleInterruptedUi();
      return;
    }

    if (result.status === 'approval-required' && result.pendingApproval) {
      setStatus('approval-required');
      setAwaitingReply(false);
      setPendingToolApproval(result.pendingApproval);
      setApprovalSelection(defaultApprovalSelection(result.pendingApproval.risk));
      append('system', result.summary);
      return;
    }

    if (!sawAgentText) {
      appendApprovalResult(append, result);
    }
    finalizeThinkingDurations();
    setAwaitingReply(false);
    setStatus('ready');
  }, [
    agentRuntime,
    append,
    enqueueMessageUpdate,
    finalizeThinkingDurations,
    flushMessageUpdates,
    pendingToolApproval,
    processingRef,
    setApprovalSelection,
    setAwaitingReply,
    setLoadingVariant,
    setPendingToolApproval,
    setStatus,
    setStreamingMessageId,
    settleInterruptedUi
  ]);

  const choosePlanApproval = useCallback(async (approved: boolean) => {
    if (!pendingConductorPlan) {
      append('system', t('app.noConductorPlan'));
      return;
    }

    const pending = pendingConductorPlan;
    setPendingConductorPlan(undefined);

    if (!approved) {
      agentRuntime.clearPendingModeExecution();
      setStatus('ready');
      append('system', t('app.conductorCancelled'));
      return;
    }

    append('system', t('app.conductorConfirmed'));
    processingRef.current = true;
    try {
      await runTurn(pending.prompt, {
        planApproved: true,
        requestedMode: pending.mode
      });
    } finally {
      processingRef.current = false;
    }
  }, [
    append,
    pendingConductorPlan,
    processingRef,
    runTurn,
    setPendingConductorPlan,
    setStatus
  ]);

  const interruptCurrentRun = useCallback((): boolean => {
    const active = activeOperationRef.current;
    if (active) {
      if (!active.controller.signal.aborted) {
        setStatus('interrupting');
        setAwaitingReply(true);
        active.controller.abort(new Error('用户按下 Esc'));
      }
      return true;
    }

    if (pendingToolApproval) {
      if (interruptingApprovalRunIdRef.current === pendingToolApproval.runId) {
        return true;
      }
      interruptingApprovalRunIdRef.current = pendingToolApproval.runId;
      const approval = pendingToolApproval;
      // 异步收口前锁住 submit，避免 open-turn 仍开着时 beginTurn 撞车。
      processingRef.current = true;
      setPendingToolApproval(undefined);
      setStatus('interrupting');
      setAwaitingReply(true);
      void agentRuntime
        .interruptPendingToolApproval(approval.runId, '用户按下 Esc')
        .then((result) => {
          if (result) {
            settleInterruptedUi();
          } else {
            setStatus('ready');
            setAwaitingReply(false);
          }
        })
        .catch((error) => {
          append(
            'system',
            t('app.approvalError', {
              error: error instanceof Error ? error.message : String(error)
            })
          );
          setStatus('ready');
          setAwaitingReply(false);
        })
        .finally(() => {
          interruptingApprovalRunIdRef.current = undefined;
          processingRef.current = false;
        });
      return true;
    }

    if (pendingConductorPlan) {
      setPendingConductorPlan(undefined);
      setStatus('ready');
      append('system', t('app.conductorCancelled'));
      processingRef.current = false;
      return true;
    }

    return false;
  }, [
    agentRuntime,
    append,
    pendingConductorPlan,
    pendingToolApproval,
    processingRef,
    setAwaitingReply,
    setPendingConductorPlan,
    setPendingToolApproval,
    setStatus,
    settleInterruptedUi
  ]);

  return {
    runTurn,
    chooseToolApproval,
    choosePlanApproval,
    interruptCurrentRun
  };
}
