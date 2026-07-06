#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';

import { AgentRuntime, createConfigImportController } from '@kross/core';
import { App } from './App';
import { createRuntimeOptionsFromEnv } from './createRuntime';

render(
  <App
    createRuntime={() =>
      new AgentRuntime(createRuntimeOptionsFromEnv(process.cwd(), process.env))
    }
    configImportController={createConfigImportController({
      env: process.env,
      pathEnv: process.env.PATH
    })}
  />
);
