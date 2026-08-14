/**
 * 拒绝路径穿越与奇怪字符；run 目录名只允许单段安全 id。
 * 注意：单独的 `..` 也匹配「仅点号」类非法名。
 */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeRunId(runId: string): boolean {
  if (!runId || runId.length > 200) {
    return false;
  }
  if (runId === '.' || runId === '..') {
    return false;
  }
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    return false;
  }
  return SAFE_RUN_ID.test(runId);
}
