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
import { createRuntimeOptionsFromEnv } from './createRuntime';
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
let appApi: AppTestApi | undefined;
let shuttingDown = false;
let app: ReturnType<typeof render>;

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

const shutdown = (): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // 主动退出统一保证：合并流式缓冲 → 写 JSONL/SQLite → 卸载 UI → 关闭 DB。
  appApi?.flushSession();
  try {
    app?.unmount();
  } catch {
    // ignore
  }
  closeSessionStore();
  restoreTerminal();
};

const exitProcess = (): void => {
  shutdown();
  process.exit(0);
};

app = render(
  <App
    createRuntime={() =>
      new AgentRuntime(createRuntimeOptionsFromEnv(process.cwd(), process.env))
    }
    configImportController={createConfigImportController({
      env: process.env,
      pathEnv: process.env.PATH
    })}
    fullscreen
    cwd={process.cwd()}
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

void app.waitUntilExit().finally(() => {
  appApi?.flushSession();
  closeSessionStore();
  restoreTerminal();
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
