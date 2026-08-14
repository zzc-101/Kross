import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { TraceEvent } from '../domain';
import { extractTouchedFilesFromEvents, type TouchedFile } from './changedFiles';

const execFileAsync = promisify(execFile);

const MAX_STATUS_LINES = 40;
const MAX_TOUCHED_FILES = 40;
const MAX_DIFF_STAT_LINES = 40;

export type GitRunner = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string }>;

export interface GitWorkspaceSnapshot {
  statusPorcelain: string[];
  diffStat: string;
  stagedDiffStat: string;
}

export interface DiffInspection {
  runId?: string;
  touchedFiles: TouchedFile[];
  changedFiles: string[];
  git: GitWorkspaceSnapshot | null;
  suggestedCommands: string[];
}

export interface FormatDiffOptions {
  runId?: string;
  events?: TraceEvent[];
  workspaceRoot?: string;
  git?: GitWorkspaceSnapshot | null;
  suggestedCommands?: string[];
}

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
  return { stdout, stderr };
};

export async function collectGitWorkspaceSnapshot(
  workspaceRoot: string,
  runGit: GitRunner = defaultGitRunner
): Promise<GitWorkspaceSnapshot | null> {
  try {
    const status = await runGit(['status', '--porcelain'], workspaceRoot);
    const diff = await runGit(['diff', '--stat'], workspaceRoot);
    const staged = await runGit(['diff', '--stat', '--cached'], workspaceRoot);

    return {
      statusPorcelain: status.stdout
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0),
      diffStat: diff.stdout.trim(),
      stagedDiffStat: staged.stdout.trim()
    };
  } catch {
    return null;
  }
}

export async function suggestVerifyCommands(
  workspaceRoot: string | undefined
): Promise<string[]> {
  const defaults = ['git status', 'git diff --stat'];
  if (!workspaceRoot) {
    return defaults;
  }

  try {
    const raw = await readFile(join(workspaceRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const commands: string[] = [];
    if (scripts.test) {
      commands.push('npm test -- --run');
    }
    if (scripts.typecheck) {
      commands.push('npm run typecheck');
    }
    if (scripts.build) {
      commands.push('npm run build');
    }
    return commands.length > 0 ? [...commands, ...defaults] : defaults;
  } catch {
    return defaults;
  }
}

export function buildDiffInspection(input: {
  runId?: string;
  events: TraceEvent[];
  git?: GitWorkspaceSnapshot | null;
  suggestedCommands?: string[];
}): DiffInspection {
  const touchedFiles = extractTouchedFilesFromEvents(input.events);
  return {
    runId: input.runId,
    touchedFiles,
    changedFiles: touchedFiles.map((file) => file.path),
    git: input.git ?? null,
    suggestedCommands: input.suggestedCommands ?? ['git status', 'git diff --stat']
  };
}

export function formatDiffInspection(inspection: DiffInspection): string {
  const lines: string[] = ['Diff'];

  if (inspection.runId) {
    lines.push(`run: ${inspection.runId}`);
  } else {
    lines.push('run: (none)');
  }

  lines.push('agent touched files (Write/Edit only):');
  if (inspection.touchedFiles.length === 0) {
    lines.push('- (none from Write/Edit tool calls)');
  } else {
    const shown = inspection.touchedFiles.slice(0, MAX_TOUCHED_FILES);
    for (const file of shown) {
      lines.push(`- ${file.path}  [${file.tools.join(', ')}]`);
    }
    if (inspection.touchedFiles.length > MAX_TOUCHED_FILES) {
      lines.push(
        `- … +${inspection.touchedFiles.length - MAX_TOUCHED_FILES} more`
      );
    }
  }

  if (inspection.git) {
    lines.push('git status:');
    if (inspection.git.statusPorcelain.length === 0) {
      lines.push('- clean');
    } else {
      for (const line of inspection.git.statusPorcelain.slice(0, MAX_STATUS_LINES)) {
        lines.push(`- ${line}`);
      }
      if (inspection.git.statusPorcelain.length > MAX_STATUS_LINES) {
        lines.push(
          `- … +${inspection.git.statusPorcelain.length - MAX_STATUS_LINES} more`
        );
      }
    }

    lines.push('git diff --stat:');
    lines.push(formatCappedStat(inspection.git.diffStat, '(no unstaged changes)'));

    if (inspection.git.stagedDiffStat.length > 0) {
      lines.push('git diff --stat --cached:');
      lines.push(formatCappedStat(inspection.git.stagedDiffStat, '(none)'));
    }
  } else {
    lines.push('git: unavailable (not a git repo or git failed)');
  }

  lines.push('suggested verify:');
  for (const command of inspection.suggestedCommands) {
    lines.push(`- ${command}`);
  }

  return lines.join('\n');
}

function formatCappedStat(stat: string, emptyLabel: string): string {
  if (stat.length === 0) {
    return emptyLabel;
  }
  const rows = stat.split('\n');
  if (rows.length <= MAX_DIFF_STAT_LINES) {
    return stat;
  }
  const head = rows.slice(0, MAX_DIFF_STAT_LINES).join('\n');
  return `${head}\n… +${rows.length - MAX_DIFF_STAT_LINES} more lines`;
}

export function formatDiffOptions(options: FormatDiffOptions): string {
  return formatDiffInspection(
    buildDiffInspection({
      runId: options.runId,
      events: options.events ?? [],
      git: options.git,
      suggestedCommands: options.suggestedCommands
    })
  );
}
