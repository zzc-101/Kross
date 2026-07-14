export interface NodeRuntimeInfo {
  version: string;
  modules?: string;
}

export function formatSessionStoreInitializationError(
  error: unknown,
  runtime: NodeRuntimeInfo = {
    version: process.version,
    modules: process.versions.modules
  }
): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    detail.includes('NODE_MODULE_VERSION') ||
    detail.includes('compiled against a different Node.js version')
  ) {
    const abi = runtime.modules ? `（ABI ${runtime.modules}）` : '';
    return [
      `会话存储初始化失败：better-sqlite3 与当前 Node.js ${runtime.version}${abi} 不兼容。`,
      'Kross 要求 Node.js >=22.19；请执行 `nvm use` 后运行 `npm rebuild better-sqlite3`。',
      '当前内容不会保存。'
    ].join(' ');
  }
  return `会话存储初始化失败，当前内容不会保存：${detail}`;
}
