import type { TraceEvent, VerificationReport } from '../domain';
import { findLastFileMutationIndex } from '../workspace/changedFiles';
import {
  fingerprintCommand,
  identifyVerificationCommand,
  type VerificationCommandIdentity,
  type VerificationKind
} from './verificationCommand';

export interface KnownVerificationCommand {
  command: string;
  label: string;
}

export interface CollectVerificationReportOptions {
  changedFiles: string[];
  knownCommands?: KnownVerificationCommand[];
  requestedCommand?: VerificationCommandIdentity;
}

interface CommandStart extends VerificationCommandIdentity {
  toolName: 'Bash' | 'ProcessStart' | 'Verify';
  callId?: string;
  iteration?: number;
  timestamp: string;
  eventIndex: number;
}

interface CommandOutcome extends CommandStart {
  exitCode?: number;
  status: 'passed' | 'failed' | 'unknown';
  completedAt: string;
  completedEventIndex: number;
}

export interface VerificationGateAssessment {
  required: boolean;
  satisfied: boolean;
  report: VerificationReport;
  reason: string;
  lastMutationIndex: number;
  requiredKinds: VerificationKind[];
  observedKinds: VerificationKind[];
}

export function collectVerificationReport(
  events: TraceEvent[],
  options: CollectVerificationReportOptions
): VerificationReport {
  const knownByFingerprint = new Map(
    (options.knownCommands ?? []).map((item) => [
      fingerprintCommand(item.command),
      item.label.slice(0, 240)
    ])
  );
  const startedByCallId = new Map<string, CommandStart>();
  const startedQueues = new Map<string, CommandStart[]>();
  const processCommands = new Map<string, CommandStart>();
  const outcomes: CommandOutcome[] = [];
  const allStarts: CommandStart[] = [];

  for (const [eventIndex, event] of events.entries()) {
    if (event.type === 'tool_call.started') {
      const start = commandStartFromEvent(
        event,
        eventIndex,
        knownByFingerprint
      );
      if (!start) continue;
      allStarts.push(start);
      if (start.callId) startedByCallId.set(start.callId, start);
      else {
        const queue = startedQueues.get(start.toolName) ?? [];
        queue.push(start);
        startedQueues.set(start.toolName, queue);
      }
      continue;
    }

    if (
      event.type !== 'tool_call.completed' &&
      event.type !== 'tool_call.failed' &&
      event.type !== 'tool_call.cancelled'
    ) {
      continue;
    }

    const toolName = asString(event.payload.toolName);
    if (
      toolName === 'Bash' ||
      toolName === 'ProcessStart' ||
      toolName === 'Verify'
    ) {
      const start = takeStart(event, toolName, startedByCallId, startedQueues);
      if (!start) continue;
      if (toolName === 'ProcessStart' && event.type === 'tool_call.completed') {
        const processId = asString(asRecord(event.payload.data)?.processId);
        if (processId) processCommands.set(processId, start);
        continue;
      }
      outcomes.push(outcomeFromEvent(start, event, eventIndex));
      continue;
    }

    if (toolName === 'ProcessPoll' && event.type === 'tool_call.completed') {
      const data = asRecord(event.payload.data);
      const processId = asString(data?.processId);
      const processStatus = asString(data?.status);
      if (!processId || (processStatus !== 'exited' && processStatus !== 'killed')) {
        continue;
      }
      const start = processCommands.get(processId);
      if (!start) continue;
      const exitCode = asNumber(data?.exitCode);
      outcomes.push({
        ...start,
        exitCode,
        status:
          processStatus === 'exited' && exitCode === 0 ? 'passed' : 'failed',
        completedAt: event.timestamp,
        completedEventIndex: eventIndex
      });
      processCommands.delete(processId);
    }
  }

  const lastMutationIndex = findLastFileMutationIndex(events);
  // 命令必须在最后一次修改之后开始；修改前启动、修改后结束的并行测试也无效。
  const validOutcomes = outcomes.filter(
    (outcome) =>
      outcome.eventIndex > lastMutationIndex &&
      outcome.completedEventIndex > lastMutationIndex
  );
  const validStarts = allStarts.filter(
    (start) => start.eventIndex > lastMutationIndex
  );
  const completedStarts = new Set(
    validOutcomes.map((outcome) => startIdentity(outcome))
  );
  const pending = validStarts.filter(
    (start) => !completedStarts.has(startIdentity(start))
  );
  const commands = [
    ...validOutcomes.map((outcome) => outcome.label),
    ...pending.map((start) => start.label)
  ];
  const evidence = [
    ...validOutcomes.map(formatOutcomeEvidence),
    ...pending.map(
      (start) =>
        `${start.label}: completion not observed${formatLocation(start)}`
    )
  ];

  if (validOutcomes.length === 0 && pending.length === 0) {
    const invalidatedCount =
      outcomes.length + allStarts.length - validStarts.length;
    return options.changedFiles.length > 0
      ? {
          status: 'not-run',
          commands: [],
          evidence: [],
          reason:
            invalidatedCount > 0
              ? 'Earlier verification was invalidated by a later workspace mutation; no recognized verification command ran after the last mutation.'
              : 'Workspace files changed, but no recognized verification command was observed after the last mutation.'
        }
      : {
          status: 'not-needed',
          commands: [],
          evidence: [],
          reason: 'No workspace file changes or verification commands were observed.'
        };
  }

  const latestByLabel = new Map<string, CommandOutcome>();
  for (const outcome of validOutcomes) latestByLabel.set(outcome.label, outcome);
  const latest = [...latestByLabel.values()];
  const hasFailure = latest.some((outcome) => outcome.status === 'failed');
  const hasUnknown =
    pending.length > 0 || latest.some((outcome) => outcome.status === 'unknown');

  if (hasFailure) {
    return {
      status: 'failed',
      commands,
      evidence,
      reason: 'At least one latest verification command failed.'
    };
  }
  if (hasUnknown) {
    return {
      status: 'not-run',
      commands,
      evidence,
      reason: 'A verification command was observed without a confirmed exit status.'
    };
  }
  return {
    status: 'passed',
    commands,
    evidence
  };
}

/**
 * 评估模型是否可以结束当前工具循环。文档类变更允许带 not-run 报告收口；
 * 代码和配置变更至少需要一次在最后 mutation 之后通过的已识别检查。
 */
export function assessVerificationGate(
  events: TraceEvent[],
  options: CollectVerificationReportOptions
): VerificationGateAssessment {
  const report = collectVerificationReport(events, options);
  const requestedCommandPassed = options.requestedCommand
    ? report.status === 'passed' &&
      report.commands.some((command) =>
        command.split(' && ').includes(options.requestedCommand!.label)
      )
    : true;
  const requiredKinds = requiredVerificationKinds(options.changedFiles);
  const codeChangeRequiresCheck =
    options.changedFiles.length > 0 &&
    !options.changedFiles.every(isDocumentationFile);
  const observedKinds =
    report.status === 'passed'
      ? collectReportKinds(report, options.knownCommands ?? [])
      : [];
  const requiredKindsPassed =
    requiredKinds.length > 0
      ? requiredKinds.every((kind) => observedKinds.includes(kind))
      : !codeChangeRequiresCheck ||
        observedKinds.some((kind) =>
          ['test', 'typecheck', 'build'].includes(kind)
        );
  const required = Boolean(options.requestedCommand) || codeChangeRequiresCheck;
  const satisfied =
    !required ||
    (report.status === 'passed' &&
      requestedCommandPassed &&
      requiredKindsPassed);
  let reason: string;
  if (satisfied) {
    reason = required
      ? 'Post-mutation verification passed.'
      : 'No completion-blocking verification is required for this run.';
  } else if (options.requestedCommand && !requestedCommandPassed) {
    reason = `The explicitly requested verification command (${options.requestedCommand.label}) did not pass.`;
  } else if (!requiredKindsPassed && report.status === 'passed') {
    reason =
      requiredKinds.length > 0
        ? `Verification passed, but the change risk also requires: ${requiredKinds.join(' + ')}.`
        : 'Verification passed, but code changes require a related test, typecheck, or build check.';
  } else {
    reason =
      report.reason ??
      'A recognized verification command must pass after the last workspace mutation.';
  }

  const effectiveReport: VerificationReport =
    !satisfied && report.status !== 'failed'
      ? { ...report, status: 'not-run', reason }
      : report;

  return {
    required,
    satisfied,
    report: effectiveReport,
    reason,
    lastMutationIndex: findLastFileMutationIndex(events),
    requiredKinds,
    observedKinds
  };
}

function commandStartFromEvent(
  event: TraceEvent,
  eventIndex: number,
  knownByFingerprint: Map<string, string>
): CommandStart | undefined {
  const toolName = asString(event.payload.toolName);
  if (
    toolName !== 'Bash' &&
    toolName !== 'ProcessStart' &&
    toolName !== 'Verify'
  ) {
    return undefined;
  }
  const input = asRecord(event.payload.input);
  const rawCommand = asString(input?.command);
  const fingerprint =
    asString(input?.commandFingerprint) ??
    (rawCommand ? fingerprintCommand(rawCommand) : undefined);
  const recognized = rawCommand
    ? identifyVerificationCommand(rawCommand)
    : undefined;
  const label =
    asString(input?.verificationCommand) ??
    recognized?.label ??
    (fingerprint ? knownByFingerprint.get(fingerprint) : undefined);
  if (!label || !fingerprint) return undefined;

  return {
    toolName,
    callId: asString(event.payload.callId),
    label: label.slice(0, 240),
    kinds: recognized?.kinds ?? [],
    fingerprint,
    iteration: asNumber(event.payload.iteration),
    timestamp: event.timestamp,
    eventIndex
  };
}

function takeStart(
  event: TraceEvent,
  toolName: 'Bash' | 'ProcessStart' | 'Verify',
  byCallId: Map<string, CommandStart>,
  queues: Map<string, CommandStart[]>
): CommandStart | undefined {
  const callId = asString(event.payload.callId);
  if (callId) return byCallId.get(callId);
  return queues.get(toolName)?.shift();
}

function outcomeFromEvent(
  start: CommandStart,
  event: TraceEvent,
  eventIndex: number
): CommandOutcome {
  const exitCode =
    asNumber(asRecord(event.payload.data)?.exitCode) ??
    parseExitCode(asString(event.payload.summary));
  return {
    ...start,
    exitCode,
    status:
      event.type === 'tool_call.completed'
        ? exitCode === undefined
          ? 'unknown'
          : exitCode === 0
            ? 'passed'
            : 'failed'
        : event.type === 'tool_call.failed'
          ? 'failed'
          : 'unknown',
    completedAt: event.timestamp,
    completedEventIndex: eventIndex
  };
}

function formatOutcomeEvidence(outcome: CommandOutcome): string {
  const exit =
    outcome.exitCode === undefined ? 'exit=unknown' : `exit=${outcome.exitCode}`;
  return `${outcome.label}: ${outcome.status} (${exit}${formatLocation({
    iteration: outcome.iteration,
    timestamp: outcome.completedAt
  })})`;
}

function formatLocation(
  start: Pick<CommandStart, 'iteration' | 'timestamp'>
): string {
  const iteration =
    start.iteration === undefined ? '' : `, iteration=${start.iteration}`;
  return `${iteration}, at=${start.timestamp}`;
}

function startIdentity(start: CommandStart): string {
  return start.callId ?? `${start.toolName}:${start.fingerprint}:${start.timestamp}`;
}

function parseExitCode(summary: string | undefined): number | undefined {
  const match = /\bexit=(-?\d+)\b/.exec(summary ?? '');
  return match ? Number(match[1]) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isDocumentationFile(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  return (
    normalized.startsWith('docs/') ||
    /(^|\/)(readme|changelog|contributing|code_of_conduct|security)(\.[^/]*)?$/.test(
      normalized
    ) ||
    /\.(md|mdx|rst|adoc|txt)$/.test(normalized)
  );
}

export function requiresVerificationForFiles(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && !changedFiles.every(isDocumentationFile);
}

function requiredVerificationKinds(changedFiles: string[]): VerificationKind[] {
  if (changedFiles.length === 0 || changedFiles.every(isDocumentationFile)) {
    return [];
  }
  return isHighRiskChange(changedFiles) ? ['test', 'build'] : [];
}

function isHighRiskChange(changedFiles: string[]): boolean {
  const normalized = changedFiles.map((path) =>
    path.replaceAll('\\', '/').toLowerCase()
  );
  const packageRoots = new Set(
    normalized
      .map((path) => /^packages\/([^/]+)\//.exec(path)?.[1])
      .filter((value): value is string => Boolean(value))
  );
  return (
    packageRoots.size > 1 ||
    normalized.some(
      (path) =>
        /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json)$/.test(
          path
        ) ||
        path.startsWith('scripts/') ||
        /(^|\/)(cli|protocol)(\/|\.|$)/.test(path)
    )
  );
}

function collectReportKinds(
  report: VerificationReport,
  knownCommands: KnownVerificationCommand[]
): VerificationKind[] {
  const knownLabels = new Set(
    knownCommands.map((item) => item.label.slice(0, 240))
  );
  const kinds = new Set<VerificationKind>();
  for (const command of report.commands) {
    const identity = identifyVerificationCommand(command);
    for (const kind of identity?.kinds ?? []) kinds.add(kind);
    if (knownLabels.has(command)) kinds.add('test');
  }
  return [...kinds];
}
