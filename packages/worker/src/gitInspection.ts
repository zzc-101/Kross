import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PATCH_MARKER = '--- KROSS PATCH ---';
const MAX_PATCH_LENGTH = 512 * 1024;

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

export async function appendGitPatch(
  workspaceRoot: string,
  summary: string,
  runGit: GitInspectionRunner = defaultRunner
): Promise<string> {
  try {
    const [unstaged, staged] = await Promise.all([
      runGit(['diff', '--no-ext-diff', '--unified=3', '--'], workspaceRoot),
      runGit(
        ['diff', '--cached', '--no-ext-diff', '--unified=3', '--'],
        workspaceRoot
      )
    ]);
    const sections = [
      unstaged.stdout.trim()
        ? `# 未暂存变更\n${unstaged.stdout.trim()}`
        : '',
      staged.stdout.trim()
        ? `# 已暂存变更\n${staged.stdout.trim()}`
        : ''
    ].filter(Boolean);
    const patch = sections.join('\n\n') || '(没有可显示的 Git patch)';
    return `${summary}\n\n${PATCH_MARKER}\n${capPatch(patch)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${summary}\n\n${PATCH_MARKER}\n(Git patch 读取失败：${message})`;
  }
}

function capPatch(value: string): string {
  if (value.length <= MAX_PATCH_LENGTH) return value;
  return `${value.slice(0, MAX_PATCH_LENGTH)}\n\n… patch 已截断（上限 512 KiB）`;
}
