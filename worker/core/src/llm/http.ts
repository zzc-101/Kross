import { LlmProviderError, type LlmFetch, type LlmProvider } from './types';

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function ensureOk(
  provider: LlmProvider,
  response: Response
): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = await response.text();
  throw new LlmProviderError(
    `${provider} request failed with status ${response.status}`,
    provider,
    response.status,
    body
  );
}

export function defaultFetch(): LlmFetch {
  if (!globalThis.fetch) {
    throw new Error('当前 Node.js 环境不支持 fetch，请升级 Node 或注入 fetch 实现');
  }

  return (url, init) => globalThis.fetch(url, init);
}
