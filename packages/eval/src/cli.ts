#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { evalCaseSchema } from './schema';
import { caseNameFromPath, runEvalCase } from './runner';

const packageRoot = resolve(import.meta.dirname, '..');
const args = parseArgs(process.argv.slice(2));
if (!args.fixture) {
  console.error(
    '真实模型 Eval 尚未启用。请显式运行 npm run eval -- --fixture。'
  );
  process.exit(2);
}

const caseDirectory = join(packageRoot, 'cases');
const caseFiles = readdirSync(caseDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .filter((name) => !args.caseId || caseNameFromPath(name) === args.caseId);
if (caseFiles.length === 0) {
  console.error(`未找到 Eval case：${args.caseId ?? '(all)'}`);
  process.exit(2);
}

const reports = [];
for (const file of caseFiles) {
  const definition = evalCaseSchema.parse(
    JSON.parse(readFileSync(join(caseDirectory, file), 'utf8'))
  );
  const outcome = await runEvalCase(definition, {
    packageRoot,
    keepWorkspace: args.keep
  });
  reports.push(outcome.report);
  if (outcome.retainedWorkspacePath) {
    console.error(
      `[kross:eval] ${definition.id} workspace: ${outcome.retainedWorkspacePath}`
    );
  }
}

console.log(`${JSON.stringify(reports, null, 2)}\n`);
if (reports.some((report) => report.status !== 'passed')) {
  process.exitCode = 1;
}

function parseArgs(values: string[]): {
  fixture: boolean;
  caseId?: string;
  keep: boolean;
} {
  const parsed: {
    fixture: boolean;
    caseId?: string;
    keep: boolean;
  } = { fixture: false, keep: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--fixture') {
      parsed.fixture = true;
      continue;
    }
    if (value === '--keep') {
      parsed.keep = true;
      continue;
    }
    if (value === '--case' && values[index + 1]) {
      parsed.caseId = values[index + 1];
      index += 1;
      continue;
    }
    console.error(`未知 Eval 参数：${value}`);
    process.exit(2);
  }
  return parsed;
}
