import { t } from '@kross/core';

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
      t('session.storeInitNodeMismatch', {
        version: runtime.version,
        abi
      }),
      t('session.storeInitNodeHint'),
      t('session.storeInitNoPersist')
    ].join(' ');
  }
  return t('session.storeInitGeneric', { detail });
}
