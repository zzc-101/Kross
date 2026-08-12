#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const inputDirs = process.argv.slice(2).map((directory) => resolve(directory));
if (inputDirs.length === 0) {
  throw new Error('用法：node summarize-results.mjs <harbor-job-dir> [...]');
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return basename(path) === 'result.json' ? [path] : [];
  });
}

const trials = inputDirs.flatMap((directory) =>
  walk(directory)
    .map((path) => ({ path, result: JSON.parse(readFileSync(path, 'utf8')) }))
    .filter(
      ({ result }) =>
        result.task_name &&
        result.agent_info &&
        result.exception_info?.exception_type !== 'CancelledError'
    )
);

function rewardOf(result) {
  const rewards = result.verifier_result?.rewards;
  if (typeof rewards === 'number') return rewards;
  if (rewards && typeof rewards === 'object') {
    const values = Object.values(rewards).filter((value) => typeof value === 'number');
    if (values.length > 0) return Math.max(...values);
  }
  const reward = result.verifier_result?.reward;
  return typeof reward === 'number' ? reward : null;
}

function krossCompletionOf(resultPath) {
  const output = join(dirname(resultPath), 'agent', 'kross.ndjson');
  if (!existsSync(output)) return null;
  let completion = null;
  for (const line of readFileSync(output, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'run.completed') completion = event.data ?? null;
    } catch {
      // A partial final NDJSON line must not invalidate the Harbor result.
    }
  }
  return completion;
}

const rows = trials.map(({ path, result }) => {
  const reward = rewardOf(result);
  const completion = krossCompletionOf(path);
  const metadata = result.agent_result?.metadata ?? null;
  const watchdog = metadata?.kross_watchdog ?? metadata?.pi_watchdog ?? null;
  const passed = (reward ?? 0) > 0;
  return {
    job: basename(resolve(path, '../../')),
    trial: result.trial_name,
    task: result.task_name,
    agent: result.agent_info.name,
    model: result.agent_info.model_info?.name ?? null,
    reward,
    passed,
    error: result.exception_info?.exception_type ?? null,
    inputTokens: result.agent_result?.n_input_tokens ?? null,
    outputTokens: result.agent_result?.n_output_tokens ?? null,
    cacheTokens: result.agent_result?.n_cache_tokens ?? null,
    costUsd: result.agent_result?.cost_usd ?? null,
    metadata,
    watchdog,
    watchdogStopped: watchdog?.triggered === true,
    claimedStatus: completion?.status ?? null,
    claimedVerificationStatus: completion?.verificationStatus ?? null,
    falseSuccess: completion?.status === 'completed' && !passed,
    startedAt: result.started_at,
    finishedAt: result.finished_at
  };
});

const groups = Object.values(
  rows.reduce((acc, row) => {
    const key = `${row.agent}::${row.model ?? 'unknown'}`;
    const group = (acc[key] ??= {
      agent: row.agent,
      model: row.model,
      trials: 0,
      passed: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      pricedTrials: 0,
      falseSuccesses: 0,
      watchdogStops: 0
    });
    group.trials += 1;
    group.passed += Number(row.passed);
    group.errors += Number(Boolean(row.error));
    group.inputTokens += row.inputTokens ?? 0;
    group.outputTokens += row.outputTokens ?? 0;
    group.cacheTokens += row.cacheTokens ?? 0;
    group.falseSuccesses += Number(row.falseSuccess);
    group.watchdogStops += Number(row.watchdogStopped);
    if (row.costUsd !== null) {
      group.costUsd += row.costUsd;
      group.pricedTrials += 1;
    }
    return acc;
  }, {})
).map((group) => ({
  ...group,
  passRate: group.trials > 0 ? group.passed / group.trials : 0,
  costCoverage: group.trials > 0 ? group.pricedTrials / group.trials : 0
}));

const taskGroups = Object.values(
  rows.reduce((acc, row) => {
    const key = `${row.agent}::${row.model ?? 'unknown'}::${row.task}`;
    const group = (acc[key] ??= {
      agent: row.agent,
      model: row.model,
      task: row.task,
      trials: 0,
      passed: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0
    });
    group.trials += 1;
    group.passed += Number(row.passed);
    group.errors += Number(Boolean(row.error));
    group.inputTokens += row.inputTokens ?? 0;
    group.outputTokens += row.outputTokens ?? 0;
    return acc;
  }, {})
).map((group) => ({
  ...group,
  passRate: group.trials > 0 ? group.passed / group.trials : 0,
  stable: group.passed === 0 || group.passed === group.trials
}));

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  jobs: inputDirs,
  groups,
  taskGroups,
  rows
};
const output = resolve('benchmarks/terminal_bench/results/phase1-report.json');
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const integer = (value) => new Intl.NumberFormat('en-US').format(value);
const completePilot = taskGroups.every((group) => group.trials === 3);
const markdown = [
  '# Kross Terminal-Bench 2.0 Phase 1',
  '',
  `生成时间：${report.generatedAt}`,
  '',
  completePilot
    ? '> 固定 10 题 Pilot，每题 3 次；不代表 Terminal-Bench 2.0 完整榜单成绩。成功与否仅以 Harbor Verifier 为准。'
    : '> 中断的诊断批次，部分任务不足 3 次，不作为最终正式成绩。成功与否仅以 Harbor Verifier 为准。',
  '',
  '## 总览',
  '',
  '| Agent | 模型 | 通过/次数 | 通过率 | 异常 | Watchdog | 输入 Token | 输出 Token | 假成功 |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ...groups.map((group) =>
    `| ${group.agent} | ${group.model ?? 'unknown'} | ${group.passed}/${group.trials} | ${percent(group.passRate)} | ${group.errors} | ${group.watchdogStops} | ${integer(group.inputTokens)} | ${integer(group.outputTokens)} | ${group.falseSuccesses} |`
  ),
  '',
  '## 分任务结果',
  '',
  '| Agent | 任务 | 通过/次数 | 通过率 | 稳定 |',
  '|---|---|---:|---:|---:|',
  ...taskGroups
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.task.localeCompare(b.task))
    .map((group) =>
      `| ${group.agent} | ${group.task} | ${group.passed}/${group.trials} | ${percent(group.passRate)} | ${group.stable ? '是' : '否'} |`
    ),
  '',
  '## 可复现性',
  '',
  ...inputDirs.map((directory) => `- Harbor Job：\`${directory}\``),
  '',
  '机器可读明细见 `phase1-report.json`；其中保留逐次 reward、异常、Token、Kross 声明状态和假成功标记。',
  ''
].join('\n');
const markdownOutput = resolve('benchmarks/terminal_bench/results/phase1-report.md');
writeFileSync(markdownOutput, markdown);
console.log(output);
console.log(markdownOutput);
