import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'packages/core/api-surface.json');
const update = process.argv.slice(2).includes('--update');
const unknownArgs = process.argv
  .slice(2)
  .filter((argument) => argument !== '--update');
if (unknownArgs.length > 0) {
  throw new Error(`未知参数：${unknownArgs.join(' ')}`);
}

const configPath = resolve(root, 'tsconfig.base.json');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(formatDiagnostic(configFile.error));
}
const parsedConfig = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  dirname(configPath)
);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const checker = program.getTypeChecker();
const publicSurface = inspectModule('packages/core/src/api/public.ts');
const experimentalSurface = inspectModule(
  'packages/core/src/api/experimental.ts'
);
const indexSurface = inspectModule('packages/core/src/index.ts');
const overlap = publicSurface.names.filter((name) =>
  experimentalSurface.names.includes(name)
);
const expectedIndex = [
  ...new Set([...publicSurface.names, ...experimentalSurface.names])
].sort(compareStable);
const failures = [];

if (overlap.length > 0) {
  failures.push(
    `public 与 experimental 重复导出：${overlap.join(', ')}`
  );
}
compareNames('index.ts', indexSurface.names, expectedIndex, failures);

const forbiddenDeclarationPaths = [
  'runtime/conductorExecution.ts',
  'runtime/modeFlows.ts',
  'runtime/modelSession.ts',
  'runtime/sessionServices.ts',
  'runtime/toolLoop.ts'
];
for (const item of [...publicSurface.symbols, ...experimentalSurface.symbols]) {
  if (
    forbiddenDeclarationPaths.some((path) =>
      item.declarationPath.endsWith(path)
    )
  ) {
    failures.push(
      `${item.name} 来自内部模块 ${item.declarationPath}，不得进入顶层 API`
    );
  }
}

const current = {
  schemaVersion: 1,
  public: publicSurface.names,
  experimental: experimentalSurface.names
};
if (update) {
  if (failures.length > 0) {
    printFailures(failures);
    process.exitCode = 1;
  } else {
    writeFileSync(
      manifestPath,
      `${JSON.stringify(current, null, 2)}\n`,
      'utf8'
    );
    console.log(
      `Core API 快照已更新：${current.public.length} public，` +
      `${current.experimental.length} experimental`
    );
  }
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1) {
    failures.push(
      `api-surface.json schemaVersion=${String(manifest.schemaVersion)}，应为 1`
    );
  }
  compareNames(
    'public API',
    publicSurface.names,
    manifest.public,
    failures
  );
  compareNames(
    'experimental API',
    experimentalSurface.names,
    manifest.experimental,
    failures
  );
  if (failures.length > 0) {
    printFailures(failures);
    console.error(
      '确认边界变化后运行 npm run api:update，并在 CHANGELOG 中说明。'
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Core API 检查通过：${current.public.length} public，` +
      `${current.experimental.length} experimental`
    );
  }
}

function inspectModule(relativePath) {
  const absolutePath = resolve(root, relativePath);
  const source = program.getSourceFile(absolutePath);
  if (!source) {
    throw new Error(`TypeScript Program 缺少 ${relativePath}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    throw new Error(`无法读取模块符号：${relativePath}`);
  }
  const exports = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      const declaration = target.declarations?.[0];
      return {
        name: symbol.name,
        declarationPath: declaration
          ? relative(
              resolve(root, 'packages/core/src'),
              declaration.getSourceFile().fileName
            ).replaceAll('\\', '/')
          : '(unknown)'
      };
    })
    .sort((left, right) => compareStable(left.name, right.name));
  return {
    names: exports.map((item) => item.name),
    symbols: exports
  };
}

function compareNames(label, actual, expected, failures) {
  if (!Array.isArray(expected)) {
    failures.push(`${label} 快照不是数组`);
    return;
  }
  const normalizedExpected = [...expected].sort(compareStable);
  const added = actual.filter((name) => !normalizedExpected.includes(name));
  const removed = normalizedExpected.filter((name) => !actual.includes(name));
  if (added.length > 0) {
    failures.push(`${label} 未登记新增：${added.join(', ')}`);
  }
  if (removed.length > 0) {
    failures.push(`${label} 已移除但快照仍存在：${removed.join(', ')}`);
  }
  if (new Set(expected).size !== expected.length) {
    failures.push(`${label} 快照包含重复名称`);
  }
  if (JSON.stringify(expected) !== JSON.stringify(normalizedExpected)) {
    failures.push(`${label} 快照必须按名称排序`);
  }
}

function printFailures(failures) {
  console.error('Core API 检查失败：');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function compareStable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
