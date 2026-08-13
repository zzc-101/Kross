import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { build } from 'esbuild';

const target = process.argv[2];
const output = process.argv[3];

if (target !== 'worker' || !output) {
  throw new Error('用法: node scripts/build-cloud-runtime.mjs worker <output>');
}

const root = process.cwd();
const outfile = resolve(root, output);

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(root, 'packages/worker/src/main.ts')],
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
    '@kross/protocol': resolve(root, 'packages/protocol/src/index.ts'),
    '@kross/work-domain': resolve(root, 'packages/work-domain/src/index.ts'),
    '@kross/work-runtime': resolve(root, 'packages/work-runtime/src/index.ts')
  },
  logLevel: 'info'
});
