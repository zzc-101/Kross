import { execFileSync } from 'node:child_process';
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

try {
  await mkdir(packDirectory);
  await mkdir(installDirectory);

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

  console.log(
    `Package smoke test passed: ${packageJson.name}@${packageJson.version} (${packedFiles.size} files)`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
