#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentRuntime,
  createConfigImportController,
  HybridSessionStore,
  initI18n,
  loadKrossConfig,
  resolveLocale
} from '@kross/core';
import { App, type AppTestApi } from './App';
import { formatSessionStoreInitializationError } from './app/sessionStartup';
import {
  bootstrapRuntimeTooling,
  createRuntimeOptionsFromEnv,
  type RuntimeTooling
} from './createRuntime';
import {
  canUseAlternateScreen,
  enterAlternateScreen,
  leaveAlternateScreen
} from './terminal/alternateScreen';
import { createTerminalFrameOutput } from './terminal/frameOutput';

initI18n(
  resolveLocale({
    env: process.env,
    configLocale: loadKrossConfig()?.locale
  })
);

const useAltScreen = canUseAlternateScreen();

if (useAltScreen) {
  enterAlternateScreen();
}

const renderStdout = useAltScreen
  ? createTerminalFrameOutput(process.stdout)
  : process.stdout;

const sessionSetup = createSessionStore();
let sessionStoreClosed = false;
let toolingClosePromise: Promise<void> | undefined;
let appApi: AppTestApi | undefined;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;
let app: ReturnType<typeof render>;
let tooling: RuntimeTooling | undefined;

const restoreTerminal = (): void => {
  if (useAltScreen) {
    leaveAlternateScreen();
  }
};

const closeSessionStore = (): void => {
  if (sessionStoreClosed) {
    return;
  }
  sessionStoreClosed = true;
  try {
    sessionSetup.store?.close();
  } catch {
    // best-effort during process shutdown
  }
};

const closeTooling = async (): Promise<void> => {
  if (!tooling) {
    return;
  }
  toolingClosePromise ??= tooling.close().catch(() => undefined);
  await toolingClosePromise;
};

const shutdown = (): Promise<void> => {
  shutdownPromise ??= (async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 主动退出统一保证：flush → unmount → DB → managed processes/MCP。
    appApi?.flushSession();
    try {
      app?.unmount();
    } catch {
      // ignore
    }
    closeSessionStore();
    await closeTooling();
    restoreTerminal();
  })();
  return shutdownPromise;
};

const exitProcess = (): void => {
  void shutdown().finally(() => process.exit(0));
};

async function main(): Promise<void> {
  const cwd = process.cwd();
  try {
    tooling = await bootstrapRuntimeTooling(cwd, process.env);
  } catch (error) {
    // MCP bootstrap should soft-fail inside connectAndRegister; this is a hard failure.
    console.error(
      '[kross:mcp] bootstrap failed:',
      error instanceof Error ? error.message : error
    );
    tooling = undefined;
  }

  const sharedTooling = tooling
    ? {
        toolGateway: tooling.toolGateway,
        traceStore: tooling.traceStore,
        todoStore: tooling.todoStore,
        setLlmClient: tooling.setLlmClient,
        runSubagent: tooling.runSubagent,
        workspaceRoots: tooling.workspaceRoots,
        skillRegistry: tooling.skillRegistry,
        mutationCoordinator: tooling.mutationCoordinator,
        processManager: tooling.processManager
      }
    : undefined;

  app = render(
    <App
      createRuntime={() =>
        new AgentRuntime(
          createRuntimeOptionsFromEnv(
            cwd,
            process.env,
            undefined,
            {},
            sharedTooling
          )
        )
      }
      configImportController={createConfigImportController({
        env: process.env,
        pathEnv: process.env.PATH
      })}
      fullscreen
      cwd={cwd}
      branch={detectGitBranch()}
      version={readPackageVersion()}
      sessionStore={sessionSetup.store}
      sessionStoreError={sessionSetup.error}
      onReady={(api) => {
        appApi = api;
      }}
      onExitRequest={exitProcess}
    />,
    {
      stdout: renderStdout,
      // Ctrl+C 交给 App，自行 flush 后再卸载，避免 Ink 抢先关闭进程。
      exitOnCtrlC: false,
      patchConsole: true
    }
  );

  const onSignal = (): void => {
    exitProcess();
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  void app.waitUntilExit().finally(async () => {
    appApi?.flushSession();
    closeSessionStore();
    await closeTooling();
    restoreTerminal();
  });
}

void main().catch((error) => {
  console.error(error);
  restoreTerminal();
  process.exit(1);
});

function createSessionStore(): {
  store?: HybridSessionStore;
  error?: string;
} {
  try {
    return { store: new HybridSessionStore() };
  } catch (error) {
    return {
      error: formatSessionStoreInitializationError(error)
    };
  }
}

function detectGitBranch(): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

function readPackageVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}
