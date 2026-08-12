#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const output = resolve(process.argv[2] ?? '.benchmark-secrets/terminal-bench.env');
const configPath = join(homedir(), '.kross', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const profiles = config.models?.profiles ?? [];
const activeId = config.models?.activeProfileId;
const profile = profiles.find((item) => item.id === activeId) ?? profiles[0];
if (!profile) throw new Error('Kross 没有已配置的模型档案');
if (profile.provider !== 'anthropic') {
  throw new Error(`当前脚本只支持 anthropic 兼容档案，实际为 ${profile.provider}`);
}
if (!profile.apiKey || !profile.model || !profile.baseUrl) {
  throw new Error('当前模型档案缺少 apiKey、model 或 baseUrl');
}

const values = {
  AGENT_LLM_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: profile.apiKey,
  ANTHROPIC_MODEL: profile.model,
  ANTHROPIC_BASE_URL: profile.baseUrl,
  AGENT_THINKING_EFFORT: profile.thinkingEffort ?? 'high'
};
const encode = (value) => JSON.stringify(String(value));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `${Object.entries(values).map(([key, value]) => `${key}=${encode(value)}`).join('\n')}\n`,
  { mode: 0o600 }
);
chmodSync(output, 0o600);
console.log(output);
