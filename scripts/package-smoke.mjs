import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageJson = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8')
);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'kross-package-'));
const packDirectory = join(temporaryRoot, 'pack');
const installDirectory = join(temporaryRoot, 'install');
const smokeHome = join(temporaryRoot, 'home');

try {
  await mkdir(packDirectory);
  await mkdir(installDirectory);
  await mkdir(smokeHome);

  const packOutput = execFileSync(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    { cwd: root, encoding: 'utf8' }
  );
  const [packResult] = JSON.parse(packOutput);
  if (!packResult?.filename || !Array.isArray(packResult.files)) {
    throw new Error('npm pack did not return package metadata');
  }

  const packedFiles = new Set(
    packResult.files.map((file) => String(file.path).replaceAll('\\', '/'))
  );
  for (const required of [
    'dist/kross.js',
    'dist/kross.js.map',
    'package.json',
    'README.md',
    'LICENSE'
  ]) {
    if (!packedFiles.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }

  const leakedSource = [...packedFiles].find(
    (file) =>
      file.startsWith('packages/') ||
      file.startsWith('scripts/') ||
      /(?:^|\/)__tests__(?:\/|$)/u.test(file) ||
      /\.test\.[cm]?[jt]sx?$/u.test(file)
  );
  if (leakedSource) {
    throw new Error(`Packed artifact unexpectedly contains ${leakedSource}`);
  }

  await writeFile(
    join(installDirectory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
    'utf8'
  );

  const tarball = join(packDirectory, packResult.filename);
  execFileSync(
    npm,
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball
    ],
    { cwd: installDirectory, stdio: 'pipe' }
  );

  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import Database from 'better-sqlite3'; new Database(':memory:').close();"
    ],
    { cwd: installDirectory, stdio: 'pipe' }
  );

  const bin = join(
    installDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'kross.cmd' : 'kross'
  );
  const installedEntry = join(
    installDirectory,
    'node_modules',
    ...packageJson.name.split('/'),
    'dist',
    'kross.js'
  );
  const version = execFileSync(bin, ['--version'], {
    cwd: installDirectory,
    encoding: 'utf8'
  }).trim();
  if (version !== packageJson.version) {
    throw new Error(
      `Expected version ${packageJson.version}, received ${version}`
    );
  }

  const help = execFileSync(bin, ['--help'], {
    cwd: installDirectory,
    encoding: 'utf8'
  });
  if (!help.includes('kross --version')) {
    throw new Error('Installed CLI help output is incomplete');
  }

  const smokeKrossHome = join(smokeHome, '.kross');
  const smokeConfig = join(smokeKrossHome, 'config.json');
  await mkdir(smokeKrossHome);
  await writeFile(
    smokeConfig,
    `${JSON.stringify({ locale: 'en' })}\n`,
    'utf8'
  );
  const migrationPlan = JSON.parse(
    execFileSync(bin, ['migrate', '--home', smokeHome], {
      cwd: installDirectory,
      encoding: 'utf8'
    })
  );
  if (
    migrationPlan.status !== 'planned' ||
    migrationPlan.mode !== 'dry-run' ||
    JSON.parse(await readFile(smokeConfig, 'utf8')).version !== undefined
  ) {
    throw new Error('Installed migration dry-run changed data or missed plan');
  }
  const migrationApply = JSON.parse(
    execFileSync(bin, ['migrate', '--apply', '--home', smokeHome], {
      cwd: installDirectory,
      encoding: 'utf8'
    })
  );
  if (
    migrationApply.status !== 'applied' ||
    JSON.parse(await readFile(smokeConfig, 'utf8')).version !== 1
  ) {
    throw new Error('Installed migration apply smoke failed');
  }

  const smokeEnvironment = {
    ...process.env,
    HOME: smokeHome,
    USERPROFILE: smokeHome,
    CI: '1',
    TERM: 'dumb',
    KROSS_STARTUP_SMOKE: '1'
  };
  for (const name of [
    'AGENT_LLM_PROVIDER',
    'AGENT_LLM_MODEL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'XAI_API_KEY'
  ]) {
    delete smokeEnvironment[name];
  }
  const headless = spawnSync(
    process.execPath,
    [installedEntry, 'exec', 'inspect the package', '--json'],
    {
      cwd: installDirectory,
      encoding: 'utf8',
      env: smokeEnvironment,
      timeout: 15_000
    }
  );
  if (headless.error) {
    throw new Error(
      `Installed headless startup failed: ${headless.error.message}`
    );
  }
  const headlessLines = headless.stdout.trim().split('\n').filter(Boolean);
  const headlessEvents = headlessLines.map((line) => JSON.parse(line));
  if (
    headless.status !== 3 ||
    headlessEvents.length !== 1 ||
    headlessEvents[0]?.schemaVersion !== 1 ||
    headlessEvents[0]?.type !== 'error' ||
    headlessEvents[0]?.data?.category !== 'configuration'
  ) {
    throw new Error(
      [
        `Installed headless config smoke exited with ${String(headless.status)}`,
        headless.stdout,
        headless.stderr
      ].join('\n')
    );
  }

  const startup = spawnSync(process.execPath, [installedEntry], {
    cwd: installDirectory,
    encoding: 'utf8',
    env: smokeEnvironment,
    timeout: 15_000
  });
  if (startup.error) {
    throw new Error(
      `Installed TUI startup failed: ${startup.error.message}\n${startup.stderr}`
    );
  }
  if (
    startup.status !== 0 ||
    !`${startup.stdout}${startup.stderr}`.includes(
      '[kross:startup-smoke] ready'
    )
  ) {
    throw new Error(
      [
        `Installed TUI startup smoke exited with ${String(startup.status)}`,
        startup.stdout,
        startup.stderr
      ].join('\n')
    );
  }

  console.log(
    `Package smoke test passed: ${packageJson.name}@${packageJson.version} (${packedFiles.size} files, TUI/headless/migrate ready)`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
