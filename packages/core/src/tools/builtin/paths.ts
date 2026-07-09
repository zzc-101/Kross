import { isAbsolute, normalize, resolve, sep } from 'node:path';

export class ToolBoundaryError extends Error {
  constructor(readonly attemptedPath: string) {
    super(`路径超出 workspace 范围，已拒绝：${attemptedPath}`);
    this.name = 'ToolBoundaryError';
  }
}

/**
 * 将用户输入路径解析为 workspace 内的绝对路径，越界则抛错。
 * 不解析符号链接，仅基于规范化后的前缀判断。
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
