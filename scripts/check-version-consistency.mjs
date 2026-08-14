import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = parseArgs(process.argv.slice(2));
const failures = [];

const manifests = [
  { path: 'frontend/package.json', lockfile: 'frontend/package-lock.json', lockPath: '' },
  { path: 'frontend/web/package.json', lockfile: 'frontend/package-lock.json', lockPath: 'web' },
  {
    path: 'frontend/admin-web/package.json',
    lockfile: 'frontend/package-lock.json',
    lockPath: 'admin-web'
  },
  { path: 'worker/package.json', lockfile: 'worker/package-lock.json', lockPath: '' }
].map((entry) => ({
  ...entry,
  manifest: readJson(entry.path),
  lock: readJson(entry.lockfile)
}));

const versions = new Set(manifests.map((entry) => entry.manifest.version));
if (versions.size !== 1 || !isSemver([...versions][0])) {
  failures.push(
    `frontend 与 worker 的 version 必须是同一个完整 SemVer，当前为 ${
      [...versions].join(', ') || '缺失'
    }`
  );
}
const appVersion = [...versions][0];

const nodeVersion = readText('.nvmrc').trim().replace(/^v/u, '');
const frontendEngines = String(manifests[0]?.manifest.engines?.node ?? '').match(
  /^>=\s*(\d+\.\d+\.\d+)$/u
)?.[1];
const workerEngines = String(
  manifests.find((entry) => entry.path === 'worker/package.json')?.manifest.engines?.node ?? ''
).match(/^>=\s*(\d+\.\d+\.\d+)$/u)?.[1];
if (!frontendEngines || frontendEngines !== workerEngines) {
  failures.push('frontend 与 worker 的 engines.node 必须同为 >=x.y.z');
} else if (nodeVersion !== frontendEngines) {
  failures.push(
    `.nvmrc 为 ${nodeVersion}，应与 engines.node 最低版本 ${frontendEngines} 一致`
  );
}

const mcpVersion = readText('worker/core/src/mcp/mcpClient.ts').match(
  /clientVersion\s*\?\?\s*'([^']+)'/u
)?.[1];
if (mcpVersion !== appVersion) {
  failures.push(
    `worker/core/src/mcp/mcpClient.ts 的运行时兜底版本为 ${mcpVersion ?? '未找到'}，应为 ${appVersion}`
  );
}

for (const entry of manifests) {
  const lockEntry = entry.lock.packages?.[entry.lockPath];
  if (!lockEntry) {
    failures.push(`${entry.lockfile} 缺少 ${entry.lockPath || '根'} 条目`);
    continue;
  }
  if (lockEntry.name !== undefined && lockEntry.name !== entry.manifest.name) {
    failures.push(
      `${entry.lockfile} 的 ${entry.lockPath || '根'} 名称为 ${lockEntry.name}，应为 ${entry.manifest.name}`
    );
  }
  if (lockEntry.version !== entry.manifest.version) {
    failures.push(
      `${entry.lockfile} 的 ${entry.lockPath || '根'} 版本为 ${lockEntry.version}，应为 ${entry.manifest.version}`
    );
  }
}

if (args.tag !== undefined && args.tag !== `v${appVersion}`) {
  failures.push(`标签 ${args.tag} 与应用版本不一致，应为 v${appVersion}`);
}

const changelog = readText('CHANGELOG.md');
if (!/^## \[Unreleased\]$/mu.test(changelog)) {
  failures.push('CHANGELOG.md 缺少 [Unreleased] 标题');
}
if (args.release) {
  const escapedVersion = escapeRegExp(appVersion);
  if (!new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'mu').test(changelog)) {
    failures.push(
      `发布检查要求 CHANGELOG.md 包含 “## [${appVersion}] - YYYY-MM-DD”`
    );
  }
  if (!new RegExp(`^\\[${escapedVersion}\\]: https://`, 'mu').test(changelog)) {
    failures.push(
      `发布检查要求 CHANGELOG.md 包含 [${appVersion}] 的链接定义`
    );
  }
}

if (failures.length > 0) {
  console.error('版本一致性检查失败：');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  const suffix = args.release ? '（发布模式）' : '';
  console.log(`版本一致性检查通过：${appVersion}${suffix}`);
}

function parseArgs(values) {
  const parsed = { release: false, tag: undefined };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--release') {
      parsed.release = true;
      continue;
    }
    if (value === '--tag') {
      parsed.tag = values[index + 1];
      index += 1;
      if (!parsed.tag) {
        throw new Error('--tag 需要一个标签值');
      }
      continue;
    }
    throw new Error(`未知参数：${value}`);
  }
  return parsed;
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  return readFileSync(join(root, path), 'utf8');
}

function isSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
    value
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
