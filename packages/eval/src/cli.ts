#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createLlmClientForProvider,
  isLlmProvider,
  type LlmProvider
} from '@kross/core';

import { buildProviderMatrix } from './providerMatrix';
import { caseNameFromPath, runEvalCase } from './runner';
import { evalCaseSchema, type EvalCase, type EvalReport } from './schema';

const packageRoot = resolve(import.meta.dirname, '..');

interface CliArgs {
  fixture: boolean;
  provider?: LlmProvider;
  model?: string;
  caseId?: string;
  keep: boolean;
  matrix: boolean;
  runs: number;
  budgetUsd?: number;
}

class CliUsageError extends Error {}

try {
  await main(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}

async function main(args: CliArgs): Promise<void> {
  validateMode(args);
  const definitions = loadCases(args.caseId);
  const reports: EvalReport[] = [];
  let stoppedByBudget = false;

  for (const definition of definitions) {
    if (args.fixture) {
      const outcome = await runEvalCase(definition, {
        packageRoot,
        keepWorkspace: args.keep,
        target: { kind: 'fixture' }
      });
      reports.push(outcome.report);
      reportRetainedPaths(definition, outcome);
      continue;
    }

    let remainingBudget = args.budgetUsd!;
    for (let attempt = 1; attempt <= args.runs; attempt += 1) {
      if (remainingBudget <= 0) {
        stoppedByBudget = true;
        break;
      }
      const client = createLlmClientForProvider(
        args.provider!,
        args.model!,
        process.env
      );
      const outcome = await runEvalCase(definition, {
        packageRoot,
        keepWorkspace: args.keep,
        attempt,
        target: {
          kind: 'provider',
          client,
          provider: args.provider!,
          model: args.model!,
          maxCostUsd: remainingBudget
        }
      });
      reports.push(outcome.report);
      reportRetainedPaths(definition, outcome);

      const cost = outcome.report.usage.estimatedCostUsd;
      if (cost === undefined) {
        stoppedByBudget = attempt < args.runs;
        if (stoppedByBudget) {
          console.error(
            '[kross:eval] Provider 未返回可用价格，无法安全执行后续重复运行'
          );
        }
        break;
      }
      remainingBudget -= cost;
      if (remainingBudget <= 0 && attempt < args.runs) {
        stoppedByBudget = true;
        console.error(
          `[kross:eval] 总预算 $${args.budgetUsd!.toFixed(6)} 已耗尽，停止后续运行`
        );
        break;
      }
    }
  }

  console.log(
    `${JSON.stringify(
      args.matrix
        ? { reports, providerMatrix: buildProviderMatrix(reports) }
        : reports,
      null,
      2
    )}\n`
  );
  if (
    stoppedByBudget ||
    reports.some((report) => report.status !== 'passed')
  ) {
    process.exitCode = 1;
  }
}

function loadCases(caseId?: string): EvalCase[] {
  const caseDirectory = join(packageRoot, 'cases');
  const caseFiles = readdirSync(caseDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .filter((name) => !caseId || caseNameFromPath(name) === caseId);
  if (caseFiles.length === 0) {
    throw new CliUsageError(`未找到 Eval case：${caseId ?? '(all)'}`);
  }
  return caseFiles.map((file) =>
    evalCaseSchema.parse(
      JSON.parse(readFileSync(join(caseDirectory, file), 'utf8'))
    )
  );
}

function reportRetainedPaths(
  definition: EvalCase,
  outcome: Awaited<ReturnType<typeof runEvalCase>>
): void {
  if (outcome.retainedWorkspacePath) {
    console.error(
      `[kross:eval] ${definition.id} workspace: ${outcome.retainedWorkspacePath}`
    );
  }
  if (outcome.reportPath) {
    console.error(
      `[kross:eval] ${definition.id} report: ${outcome.reportPath}`
    );
  }
}

function validateMode(args: CliArgs): void {
  const hasRealOption =
    args.provider !== undefined ||
    args.model !== undefined ||
    args.budgetUsd !== undefined ||
    args.runs !== 1;
  if (args.fixture) {
    if (hasRealOption) {
      throw new CliUsageError(
        '--fixture 不能与 --provider、--model、--runs 或 --budget 同时使用'
      );
    }
    return;
  }
  if (!args.provider || !args.model || args.budgetUsd === undefined) {
    throw new CliUsageError(
      '真实 Provider Eval 必须显式提供 --provider、--model 和 --budget'
    );
  }
  if (!args.caseId) {
    throw new CliUsageError(
      '真实 Provider Eval 必须用 --case 显式选择一个 Case，避免意外产生费用'
    );
  }
}

function parseArgs(values: string[]): CliArgs {
  const parsed: CliArgs = {
    fixture: false,
    keep: false,
    matrix: false,
    runs: 1
  };
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
    if (value === '--matrix') {
      parsed.matrix = true;
      continue;
    }
    if (value === '--case') {
      parsed.caseId = requiredValue(values, ++index, value);
      continue;
    }
    if (value === '--provider') {
      const provider = requiredValue(values, ++index, value);
      if (!isLlmProvider(provider)) {
        throw new CliUsageError(`未知 Provider：${provider}`);
      }
      parsed.provider = provider;
      continue;
    }
    if (value === '--model') {
      parsed.model = requiredValue(values, ++index, value);
      continue;
    }
    if (value === '--runs') {
      parsed.runs = positiveInteger(requiredValue(values, ++index, value), value);
      if (parsed.runs > 20) {
        throw new CliUsageError('--runs 最大为 20');
      }
      continue;
    }
    if (value === '--budget') {
      parsed.budgetUsd = positiveNumber(
        requiredValue(values, ++index, value),
        value
      );
      continue;
    }
    throw new CliUsageError(`未知 Eval 参数：${value}`);
  }
  return parsed;
}

function requiredValue(
  values: string[],
  index: number,
  option: string
): string {
  const value = values[index]?.trim();
  if (!value || value.startsWith('--')) {
    throw new CliUsageError(`${option} 缺少参数`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${option} 必须是正整数`);
  }
  return parsed;
}

function positiveNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(`${option} 必须是正数`);
  }
  return parsed;
}
