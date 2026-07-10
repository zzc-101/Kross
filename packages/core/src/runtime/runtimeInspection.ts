import type { TraceEvent } from '../domain';
import { isSafeRunId } from '../trace/runId';
import type { ListRunsOptions, TraceStore } from '../trace/traceStore';
import {
  buildTraceDetail,
  formatTraceDetail,
  formatTraceList,
  summarizeTraceEvents,
  type RunTraceDetail,
  type RunTraceSummary
} from '../trace/traceSummary';
import {
  buildDiffInspection,
  collectGitWorkspaceSnapshot,
  formatDiffInspection,
  suggestVerifyCommands,
  type GitRunner
} from '../workspace/workspaceDiff';

export interface RuntimeInspectionOptions {
  traceStore: TraceStore;
  workspaceRoot?: string;
  runGit?: GitRunner;
}

export class RuntimeInspection {
  constructor(private readonly options: RuntimeInspectionOptions) {}

  async listTraces(
    options: ListRunsOptions = {}
  ): Promise<RunTraceSummary[]> {
    const limit = options.limit ?? 10;
    const runIds = await this.options.traceStore.listRunIds();
    const summaries: RunTraceSummary[] = [];

    for (const runId of runIds) {
      if (summaries.length >= limit) {
        break;
      }
      try {
        const events = await this.options.traceStore.readRun(runId);
        const summary = summarizeTraceEvents(runId, events);
        if (summary) {
          summaries.push(summary);
        }
      } catch {
        // 单 run 损坏不拖垮列表
      }
    }

    return summaries;
  }

  async inspectTrace(runId: string): Promise<RunTraceDetail | null> {
    if (!isSafeRunId(runId)) {
      return null;
    }
    try {
      const events = await this.options.traceStore.readRun(runId);
      return buildTraceDetail(runId, events);
    } catch {
      return null;
    }
  }

  async formatTraceCommand(argument?: string): Promise<string> {
    const runId = argument?.trim();
    if (!runId) {
      const summaries = await this.listTraces({ limit: 10 });
      return formatTraceList(summaries, { limit: 10 });
    }

    if (!isSafeRunId(runId)) {
      return [
        `无效 runId：${runId}`,
        'runId 仅允许字母数字与 ._-，且不能包含路径分隔符。'
      ].join('\n');
    }

    const detail = await this.inspectTrace(runId);
    if (!detail) {
      return [
        `未找到 run：${runId}`,
        '用法：/trace 查看最近运行 · /trace <runId> 查看详情'
      ].join('\n');
    }
    return formatTraceDetail(detail);
  }

  async formatDiffCommand(argument?: string): Promise<string> {
    const requested = argument?.trim();
    let runId: string | undefined;
    let events: TraceEvent[] = [];

    if (requested) {
      if (!isSafeRunId(requested)) {
        return [
          `无效 runId：${requested}`,
          'runId 仅允许字母数字与 ._-，且不能包含路径分隔符。'
        ].join('\n');
      }
      try {
        events = await this.options.traceStore.readRun(requested);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `读取 run 失败：${requested}（${message}）`;
      }
      if (events.length === 0) {
        return [
          `未找到 run：${requested}`,
          '用法：/diff · /diff <runId>'
        ].join('\n');
      }
      runId = requested;
    } else {
      const runIds = await this.options.traceStore.listRunIds();
      runId = runIds[0];
      if (runId) {
        try {
          events = await this.options.traceStore.readRun(runId);
        } catch {
          events = [];
        }
      }
    }

    const workspaceRoot = this.options.workspaceRoot;
    const git =
      workspaceRoot !== undefined
        ? await collectGitWorkspaceSnapshot(workspaceRoot, this.options.runGit)
        : null;
    const suggestedCommands = await suggestVerifyCommands(workspaceRoot);

    return formatDiffInspection(
      buildDiffInspection({ runId, events, git, suggestedCommands })
    );
  }
}
