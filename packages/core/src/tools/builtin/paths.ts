import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';

export class ToolBoundaryError extends Error {
  constructor(readonly attemptedPath: string) {
    super(`路径超出 workspace 范围，已拒绝：${attemptedPath}`);
    this.name = 'ToolBoundaryError';
  }
}

/**
 * 将用户输入路径解析为 workspace 内的绝对路径，越界则抛错。
 * 仅做词法边界检查；读写工具还需再用 realpath 系列函数校验符号链接。
 */
export function resolveWithinWorkspace(root: string, inputPath: string): string {
  const base = normalize(root);
  const target = isAbsolute(inputPath)
    ? normalize(inputPath)
    : normalize(resolve(base, inputPath));

  if (target !== base && !target.startsWith(base + sep)) {
    throw new ToolBoundaryError(inputPath);
  }
  return target;
}

export async function resolveExistingPathWithinWorkspace(
  root: string,
  inputPath: string
): Promise<string> {
  const target = resolveWithinWorkspace(root, inputPath);
  const [realBase, realTarget] = await Promise.all([
    realpath(root),
    realpath(target)
  ]);
  assertRealPathWithinWorkspace(realBase, realTarget, inputPath);
  return target;
}

export async function resolveWritablePathWithinWorkspace(
  root: string,
  inputPath: string
): Promise<string> {
  const target = resolveWithinWorkspace(root, inputPath);
  const realBase = await realpath(root);

  try {
    const realTarget = await realpath(target);
    assertRealPathWithinWorkspace(realBase, realTarget, inputPath);
    return target;
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }

  const realParent = await realpathExistingAncestor(dirname(target), root);
  assertRealPathWithinWorkspace(realBase, realParent, inputPath);
  return target;
}

async function realpathExistingAncestor(path: string, root: string): Promise<string> {
  let current = path;
  const lexicalRoot = normalize(root);

  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }

    if (current === lexicalRoot) {
      return realpath(lexicalRoot);
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new ToolBoundaryError(path);
    }
    current = parent;
  }
}

function assertRealPathWithinWorkspace(
  realBase: string,
  realTarget: string,
  attemptedPath: string
): void {
  const base = normalize(realBase);
  const target = normalize(realTarget);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ToolBoundaryError(attemptedPath);
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
