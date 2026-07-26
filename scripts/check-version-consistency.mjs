import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = parseArgs(process.argv.slice(2));
const failures = [];
const rootPackage = readJson('package.json');
const lockfile = readJson('package-lock.json');
const workspacePaths = readdirSync(join(root, 'packages'), {
  withFileTypes: true
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`)
  .filter((path) => existsSync(join(root, path, 'package.json')))
  .sort();
const workspacePackages = workspacePaths.map((path) => ({
  path,
  manifest: readJson(`${path}/package.json`)
}));
const internalNames = new Set(
  workspacePackages.map(({ manifest }) => manifest.name)
);

if (!isSemver(rootPackage.version)) {
  failures.push(`package.json 的版本号不是完整 SemVer：${rootPackage.version}`);
}

for (const { path, manifest } of workspacePackages) {
  if (manifest.version !== rootPackage.version) {
    failures.push(
      `${path}/package.json 版本为 ${manifest.version}，应为 ${rootPackage.version}`
    );
  }
  checkInternalDependencies(`${path}/package.json`, manifest);
}
checkInternalDependencies('package.json', rootPackage);

checkLockfileEntry('', 'package.json', rootPackage);
for (const { path, manifest } of workspacePackages) {
  checkLockfileEntry(path, `${path}/package.json`, manifest);
}

const nodeVersion = readText('.nvmrc').trim().replace(/^v/u, '');
const minimumNode = String(rootPackage.engines?.node ?? '').match(
  /^>=\s*(\d+\.\d+\.\d+)$/u
)?.[1];
if (!minimumNode) {
  failures.push('package.json engines.node 必须使用 >=x.y.z 格式');
} else if (nodeVersion !== minimumNode) {
  failures.push(
    `.nvmrc 为 ${nodeVersion}，应与 engines.node 最低版本 ${minimumNode} 一致`
  );
}

const runtimeVersionFiles = [
  {
    path: 'packages/core/src/mcp/mcpClient.ts',
    pattern: /clientVersion\s*\?\?\s*'([^']+)'/u
  },
  {
    path: 'packages/tui/src/main.tsx',
    pattern: /return\s+'([^']+)';\s*\n\}/u
  },
  {
    path: 'packages/tui/src/App.tsx',
    pattern: /version\s*=\s*'([^']+)'/u
  },
  {
    path: 'packages/tui/src/ui/WelcomeHome.tsx',
    pattern: /version\s*=\s*'([^']+)'/u
  }
];
for (const { path, pattern } of runtimeVersionFiles) {
  const actual = readText(path).match(pattern)?.[1];
  if (actual !== rootPackage.version) {
    failures.push(
      `${path} 的运行时兜底版本为 ${actual ?? '未找到'}，应为 ${rootPackage.version}`
    );
  }
}

if (args.tag !== undefined && args.tag !== `v${rootPackage.version}`) {
  failures.push(
    `标签 ${args.tag} 与 package.json 版本不一致，应为 v${rootPackage.version}`
  );
}

const changelog = readText('CHANGELOG.md');
if (!/^## \[Unreleased\]$/mu.test(changelog)) {
  failures.push('CHANGELOG.md 缺少 [Unreleased] 标题');
}
if (args.release) {
  const escapedVersion = escapeRegExp(rootPackage.version);
  if (!new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'mu').test(changelog)) {
    failures.push(
      `发布检查要求 CHANGELOG.md 包含 “## [${rootPackage.version}] - YYYY-MM-DD”`
    );
  }
  if (!new RegExp(`^\\[${escapedVersion}\\]: https://`, 'mu').test(changelog)) {
    failures.push(
      `发布检查要求 CHANGELOG.md 包含 [${rootPackage.version}] 的链接定义`
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
  console.log(
    `版本一致性检查通过：${rootPackage.version}，${workspacePackages.length} 个 workspace${suffix}`
  );
}

function checkInternalDependencies(path, manifest) {
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ]) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (internalNames.has(name) && range !== rootPackage.version) {
        failures.push(
          `${path} 的 ${section}.${name} 为 ${range}，应使用精确版本 ${rootPackage.version}`
        );
      }
    }
  }
}

function checkLockfileEntry(lockPath, manifestPath, manifest) {
  const entry = lockfile.packages?.[lockPath];
  if (!entry) {
    failures.push(`package-lock.json 缺少 ${lockPath || '根包'} 条目`);
    return;
  }
  if (entry.name !== manifest.name) {
    failures.push(
      `package-lock.json 的 ${lockPath || '根包'} 名称为 ${entry.name}，应为 ${manifest.name}`
    );
  }
  if (entry.version !== manifest.version) {
    failures.push(
      `package-lock.json 的 ${lockPath || '根包'} 版本为 ${entry.version}，应为 ${manifest.version}`
    );
  }
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ]) {
    const source = manifest[section] ?? {};
    const locked = entry[section] ?? {};
    for (const name of internalNames) {
      if (source[name] !== locked[name]) {
        failures.push(
          `package-lock.json 的 ${lockPath || '根包'} ${section}.${name} 与 ${manifestPath} 不一致`
        );
      }
    }
  }
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
