export interface ProviderConfig {
  provider?: 'openai' | 'anthropic' | 'openrouter' | 'deepseek' | 'xai';
  model?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  source: 'saved' | 'environment' | 'none';
}

export interface SetupStatus {
  ready: boolean;
  provider: ProviderConfig;
  checks: Array<{
    id: string;
    label: string;
    status: 'passed' | 'warning' | 'failed';
    detail: string;
  }>;
}

export interface ProviderInput {
  provider: NonNullable<ProviderConfig['provider']>;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export async function fetchSetupStatus(
  endpoint: string,
  token: string
): Promise<SetupStatus> {
  return request<SetupStatus>(endpoint, token, '/api/setup');
}

export async function saveProvider(
  endpoint: string,
  token: string,
  provider: ProviderInput,
  restartWorkers: boolean
): Promise<{ provider: ProviderConfig; restarted: string[] }> {
  return request(endpoint, token, '/api/provider', {
    method: 'PUT',
    body: JSON.stringify({ provider, restartWorkers })
  });
}

async function request<T>(
  endpoint: string,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${httpEndpoint(endpoint)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers
    }
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `请求失败（${response.status}）`);
  }
  return body;
}

export function httpEndpoint(endpoint: string): string {
  return endpoint
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/ws$/, '');
}
