import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { createCoreWorkRuntimeFactory } from './coreRuntimeFactory';
import { RunExecutor } from './runExecutor';
import { FetchWorkerControlTransport } from './transport';
import type { SourceDownloadAdapter } from '@kross/work-runtime';

export interface WorkerMainConfig {
  workerId: string;
  runId: string;
  generation: number;
  leaseId: string;
  runToken: string;
  controlPlaneUrl: string;
  runSpecUrl: string;
  physicalWorkRoot: string;
}

export function parseWorkerMainConfig(env: Record<string, string | undefined>): WorkerMainConfig {
  const runId = required(env, 'KROSS_RUN_ID');
  const generationText = required(env, 'KROSS_GENERATION');
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('KROSS_GENERATION must be a positive integer');
  const runSpecUrl = required(env, 'KROSS_RUN_SPEC_URL');
  const controlPlaneUrl = env.KROSS_CONTROL_PLANE_URL?.trim() || new URL(runSpecUrl).origin;
  return {
    workerId: env.KROSS_WORKER_ID?.trim() || `worker_${runId}_${generation}`,
    runId,
    generation,
    leaseId: required(env, 'KROSS_LEASE_ID'),
    runToken: required(env, 'KROSS_RUN_TOKEN'),
    controlPlaneUrl,
    runSpecUrl,
    physicalWorkRoot: required(env, 'KROSS_PHYSICAL_WORK_ROOT')
  };
}

export async function runWorkerMain(env: Record<string, string | undefined> = process.env): Promise<number> {
  const config = parseWorkerMainConfig(env);
  const transport = new FetchWorkerControlTransport({
    controlPlaneUrl: config.controlPlaneUrl,
    runSpecUrl: config.runSpecUrl
  });
  const downloader = createFetchSourceDownloader();
  const runtimeFactory = createCoreWorkRuntimeFactory({
    modelEnvironmentResolver: {
      async resolve() {
        // Provider credentials are injected as run-scoped environment secrets by
        // the Orchestrator. No refresh token or durable control-plane credential is accepted.
        return env;
      }
    }
  });
  const outcome = await new RunExecutor({
    lease: { workerId: config.workerId, runId: config.runId, generation: config.generation, leaseId: config.leaseId },
    runToken: config.runToken,
    physicalWorkRoot: config.physicalWorkRoot,
    transport,
    downloader,
    runtimeFactory
  }).execute();
  return outcome.status === 'completed' || outcome.status === 'waiting_for_approval' || outcome.status === 'cancelled' ? 0 : 1;
}

export function createFetchSourceDownloader(fetchImpl: typeof globalThis.fetch = globalThis.fetch): SourceDownloadAdapter {
  return {
    async downloadToFile({ source, destination, signal }) {
      const headers = Object.fromEntries(source.downloadHeaders.map((header) => [header.name, header.value]));
      const response = await fetchImpl(source.downloadUrl, { headers, signal });
      if (!response.ok) throw new Error(`Source ${source.id} download failed (${response.status})`);
      if (!response.body) throw new Error(`Source ${source.id} download returned no body`);
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        createWriteStream(destination, { mode: 0o600 }),
        { signal }
      );
    }
  };
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
