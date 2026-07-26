import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

export function generateReleaseMetadata(options) {
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8')
  );
  const expectedTag = `v${packageJson.version}`;
  if (options.tag !== expectedTag) {
    throw new Error(
      `Release tag ${options.tag} does not match package version ${packageJson.version}; expected ${expectedTag}`
    );
  }
  if (!/^[0-9a-f]{7,64}$/iu.test(options.commit)) {
    throw new Error(`Invalid release commit: ${options.commit}`);
  }

  const artifactsDirectory = resolve(options.artifactsDirectory);
  mkdirSync(artifactsDirectory, { recursive: true });
  const excluded = new Set(['release-metadata.json', 'SHA256SUMS']);
  const artifacts = readdirSync(artifactsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !excluded.has(entry.name))
    .map((entry) => {
      const content = readFileSync(join(artifactsDirectory, entry.name));
      return {
        name: entry.name,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex')
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (artifacts.length === 0) {
    throw new Error(
      `No release artifacts found in ${artifactsDirectory}`
    );
  }

  const shortCommit = options.commit.slice(0, 12);
  const images = ['web', 'server', 'worker'].map((component) => ({
    component,
    localName: `kross-${component}`,
    tags: [packageJson.version, shortCommit]
  }));
  const metadata = {
    schemaVersion: 1,
    package: {
      name: packageJson.name,
      version: packageJson.version
    },
    tag: options.tag,
    commit: options.commit,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    artifacts,
    images,
    publication: {
      npm: false,
      containerRegistry: false,
      githubRelease: false
    }
  };

  writeFileSync(
    join(artifactsDirectory, 'release-metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    join(artifactsDirectory, 'SHA256SUMS'),
    `${artifacts
      .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
      .join('\n')}\n`,
    'utf8'
  );
  return metadata;
}

function parseArgs(values) {
  const parsed = {
    tag: undefined,
    commit: undefined,
    artifactsDirectory: undefined
  };
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const value = values[index + 1];
    if (
      (name === '--tag' ||
        name === '--commit' ||
        name === '--artifacts') &&
      value
    ) {
      if (name === '--tag') parsed.tag = value;
      if (name === '--commit') parsed.commit = value;
      if (name === '--artifacts') parsed.artifactsDirectory = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${name}`);
  }
  if (!parsed.tag || !parsed.commit || !parsed.artifactsDirectory) {
    throw new Error(
      'Usage: release-metadata.mjs --tag vX.Y.Z --commit SHA --artifacts DIR'
    );
  }
  return parsed;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = parseArgs(process.argv.slice(2));
  const metadata = generateReleaseMetadata(options);
  console.log(
    `Release metadata created: ${metadata.tag} (${metadata.artifacts.length} artifacts) in ${basename(resolve(options.artifactsDirectory))}`
  );
}
