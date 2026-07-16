import { chmod, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8')
);
const outfile = resolve(root, 'dist/kross.js');

await rm(resolve(root, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [resolve(root, 'packages/tui/src/main.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.19',
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'none',
  external: Object.keys(packageJson.dependencies ?? {}),
  logLevel: 'info'
});

await chmod(outfile, 0o755);
