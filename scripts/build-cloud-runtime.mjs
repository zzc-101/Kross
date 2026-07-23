import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { build } from 'esbuild';

const target = process.argv[2];
const output = process.argv[3];

if ((target !== 'server' && target !== 'worker') || !output) {
  throw new Error(
    '用法: node scripts/build-cloud-runtime.mjs <server|worker> <output>'
  );
}

const root = process.cwd();
const entryPoint = resolve(
  root,
  target === 'server'
    ? 'packages/server/src/main.ts'
    : 'packages/worker/src/main.ts'
);
const outfile = resolve(root, output);

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minifySyntax: true,
  packages: 'external',
  alias: {
    '@kross/core': resolve(root, 'packages/core/src/index.ts'),
    '@kross/protocol': resolve(root, 'packages/protocol/src/index.ts')
  },
  logLevel: 'info'
});
