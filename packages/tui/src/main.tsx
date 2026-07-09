#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRuntime, createConfigImportController } from '@kross/core';
import { App } from './App';
import { createRuntimeOptionsFromEnv } from './createRuntime';
import {
  canUseAlternateScreen,
  enterAlternateScreen,
  leaveAlternateScreen
} from './terminal/alternateScreen';

const useAltScreen = canUseAlternateScreen();

if (useAltScreen) {
  enterAlternateScreen();
}

const app = render(
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
  />,
  {
    exitOnCtrlC: true,
    patchConsole: true
  }
);

const restoreTerminal = (): void => {
  if (useAltScreen) {
    leaveAlternateScreen();
  }
};

const onSignal = (): void => {
  try {
    app.unmount();
  } catch {
    // ignore
  }
  restoreTerminal();
  process.exit(0);
};

process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

void app.waitUntilExit().finally(() => {
  restoreTerminal();
});

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
