import { execFile } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DiskUsageRunner = (
  paths: string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: DiskUsageRunner = async (paths) => {
  const result = await execFileAsync('du', ['-sk', ...paths], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function measureWorkspaceDiskUsage(
  paths: string[],
  runner: DiskUsageRunner = defaultRunner
): Promise<number> {
  const roots = collapseNestedPaths(paths);
  const result = await runner(roots);
  let kibibytes = 0;
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+/);
    if (match?.[1]) kibibytes += Number(match[1]);
  }
  if (!Number.isFinite(kibibytes)) {
    throw new Error('无法解析工作区磁盘使用量');
  }
  return kibibytes * 1024;
}
export function formatDiskBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.ceil(bytes / 1024)} KiB`;
}

function collapseNestedPaths(paths: string[]): string[] {
  const sorted = [...new Set(paths.map((path) => resolve(path)))]
    .sort((left, right) => left.length - right.length);
  return sorted.filter(
    (candidate, index) =>
      !sorted
        .slice(0, index)
        .some(
          (parent) =>
            candidate === parent || candidate.startsWith(`${parent}${sep}`)
        )
  );
}
