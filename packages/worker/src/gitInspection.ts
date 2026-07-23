import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PATCH_LENGTH = 512 * 1024;

export interface StructuredGitInspection {
  kind: 'diff';
  summary: string;
  patches: Array<{ staged: boolean; patch: string }>;
}

export type GitInspectionRunner = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: GitInspectionRunner = async (args, cwd) => {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function inspectGitDiff(
  workspaceRoot: string,
  summary: string,
  runGit: GitInspectionRunner = defaultRunner
): Promise<StructuredGitInspection> {
  try {
    const [unstaged, staged] = await Promise.all([
      runGit(['diff', '--no-ext-diff', '--unified=3', '--'], workspaceRoot),
      runGit(
        ['diff', '--cached', '--no-ext-diff', '--unified=3', '--'],
        workspaceRoot
      )
    ]);
    const patches = [
      ...(unstaged.stdout.trim()
        ? [{ staged: false, patch: capPatch(unstaged.stdout.trim()) }]
        : []),
      ...(staged.stdout.trim()
        ? [{ staged: true, patch: capPatch(staged.stdout.trim()) }]
        : [])
    ];
    return { kind: 'diff', summary, patches };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'diff',
      summary: `${summary}\n\nGit patch 读取失败：${message}`,
      patches: []
    };
  }
}

function capPatch(value: string): string {
  if (value.length <= MAX_PATCH_LENGTH) return value;
  return `${value.slice(0, MAX_PATCH_LENGTH)}\n\n… patch 已截断（上限 512 KiB）`;
}
