#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';

import { AgentRuntime } from '@kross/core';
import { App } from './App';
import { createRuntimeOptionsFromEnv } from './createRuntime';

const runtime = new AgentRuntime(createRuntimeOptionsFromEnv(process.cwd(), process.env));

render(<App runtime={runtime} />);
