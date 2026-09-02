import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runAgentLoop } from './agentLoop';
import { createWorkerLogger } from './logger';
import { WsAgentControlTransport } from './transport';

export interface WorkerMainConfig {
  agentId: string;
  agentToken: string;
  controlPlaneUrl: string;
  physicalWorkRoot: string;
}

export function parseWorkerMainConfig(env: Record<string, string | undefined>): WorkerMainConfig {
  return {
    agentId: required(env, 'APP_AGENT_ID'),
    agentToken: required(env, 'APP_AGENT_TOKEN'),
    controlPlaneUrl: required(env, 'APP_CONTROL_PLANE_URL'),
    physicalWorkRoot: required(env, 'APP_PHYSICAL_WORK_ROOT')
  };
}

export async function runWorkerMain(env: Record<string, string | undefined> = process.env): Promise<number> {
  const config = parseWorkerMainConfig(env);
  const transport = new WsAgentControlTransport({
    agentId: config.agentId,
    agentToken: config.agentToken,
    controlPlaneUrl: config.controlPlaneUrl
  });
  let stopping = false;
  const shutdown = new AbortController();
  const onStop = () => {
    stopping = true;
    shutdown.abort(new Error('Worker is shutting down'));
    transport.close();
  };
  process.once('SIGTERM', onStop);
  process.once('SIGINT', onStop);
  try {
    await runAgentLoop({
      workspaceRoot: config.physicalWorkRoot,
      processEnv: env,
      transport,
      shouldStop: () => stopping,
      signal: shutdown.signal
    });
    return 0;
  } finally {
    process.removeListener('SIGTERM', onStop);
    process.removeListener('SIGINT', onStop);
  }
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await runWorkerMain();
  } catch (error) {
    createWorkerLogger({ agentId: process.env.APP_AGENT_ID }).error(
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}
