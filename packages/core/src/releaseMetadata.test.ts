import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const script = join(root, 'scripts', 'release-metadata.mjs');
const packageVersion = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
).version as string;
let temporary = '';

afterEach(() => {
  if (temporary) {
    rmSync(temporary, { recursive: true, force: true });
    temporary = '';
  }
});

describe('release metadata', () => {
  it('writes checksums and versioned image tags without publication flags', () => {
    temporary = mkdtempSync(join(tmpdir(), 'kross-release-'));
    const artifactName = `kross-${packageVersion}.tgz`;
    writeFileSync(join(temporary, artifactName), 'artifact');

    execFileSync(
      process.execPath,
      [
        script,
        '--tag',
        `v${packageVersion}`,
        '--commit',
        '0123456789abcdef',
        '--artifacts',
        temporary
      ],
      { cwd: root, stdio: 'pipe' }
    );
    const metadata = JSON.parse(
      readFileSync(join(temporary, 'release-metadata.json'), 'utf8')
    );

    expect(metadata).toMatchObject({
      schemaVersion: 1,
      tag: `v${packageVersion}`,
      commit: '0123456789abcdef',
      publication: {
        npm: false,
        containerRegistry: false,
        githubRelease: false
      }
    });
    expect(metadata.images[0]?.tags).toEqual([
      packageVersion,
      '0123456789ab'
    ]);
    expect(readFileSync(join(temporary, 'SHA256SUMS'), 'utf8')).toBe(
      `${metadata.artifacts[0].sha256}  ${artifactName}\n`
    );
  });

  it('rejects a tag that differs from the package version', () => {
    temporary = mkdtempSync(join(tmpdir(), 'kross-release-'));
    writeFileSync(join(temporary, 'artifact.tgz'), 'artifact');

    expect(() =>
      execFileSync(
        process.execPath,
        [
          script,
          '--tag',
          'v9.9.9',
          '--commit',
          '0123456789abcdef',
          '--artifacts',
          temporary
        ],
        { cwd: root, stdio: 'pipe' }
      )
    ).toThrow(`expected v${packageVersion}`);
  });
});
