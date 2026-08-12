import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';

import {
  PROTOCOL_VERSION,
  approvalSnapshotSchema,
  artifactSnapshotSchema,
  internalWorkerMessageSchema,
  publicEventEnvelopeSchema,
  runSnapshotSchema,
  runSpecSchema,
  sourceSnapshotSchema,
  taskSnapshotSchema,
  workerRunEventEnvelopeSchema
} from '../src/index';
import {
  findBreakingSchemaChanges,
  type JsonSchema
} from '../src/jsonSchemaCompatibility';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(packageRoot, 'schemas');
const mode = process.argv[2];
const versionSuffix = `v${PROTOCOL_VERSION}`;

if (mode !== '--check' && mode !== '--update') {
  throw new Error('用法: tsx scripts/generate-json-schemas.ts <--check|--update>');
}

const contracts = [
  contract(`KrossTaskSnapshotV${PROTOCOL_VERSION}`, `kross-task-snapshot-${versionSuffix}.schema.json`, taskSnapshotSchema),
  contract(`KrossRunSnapshotV${PROTOCOL_VERSION}`, `kross-run-snapshot-${versionSuffix}.schema.json`, runSnapshotSchema),
  contract(`KrossSourceSnapshotV${PROTOCOL_VERSION}`, `kross-source-snapshot-${versionSuffix}.schema.json`, sourceSnapshotSchema),
  contract(`KrossArtifactSnapshotV${PROTOCOL_VERSION}`, `kross-artifact-snapshot-${versionSuffix}.schema.json`, artifactSnapshotSchema),
  contract(`KrossApprovalSnapshotV${PROTOCOL_VERSION}`, `kross-approval-snapshot-${versionSuffix}.schema.json`, approvalSnapshotSchema),
  contract(
    `KrossPublicEventEnvelopeV${PROTOCOL_VERSION}`,
    `kross-public-event-envelope-${versionSuffix}.schema.json`,
    publicEventEnvelopeSchema
  ),
  contract(`KrossRunSpecV${PROTOCOL_VERSION}`, `kross-run-spec-${versionSuffix}.schema.json`, runSpecSchema),
  contract(
    `KrossWorkerRunEventEnvelopeV${PROTOCOL_VERSION}`,
    `kross-worker-run-event-envelope-${versionSuffix}.schema.json`,
    workerRunEventEnvelopeSchema
  ),
  contract(
    `KrossInternalWorkerMessageV${PROTOCOL_VERSION}`,
    `kross-internal-worker-message-${versionSuffix}.schema.json`,
    internalWorkerMessageSchema
  )
];

let failed = false;
for (const item of contracts) {
  const path = join(outputDirectory, item.file);
  const generated = generateSchema(item);
  const serialized = `${JSON.stringify(generated, null, 2)}\n`;
  const existingText = await readOptional(path);
  if (existingText === serialized) continue;

  if (mode === '--check') {
    console.error(`Protocol schema 未同步：${relative(packageRoot, path)}`);
    failed = true;
    continue;
  }

  if (existingText) {
    const existing = JSON.parse(existingText) as JsonSchema;
    const issues = findBreakingSchemaChanges(existing, generated);
    if (issues.length > 0) {
      console.error(`${item.file} 存在破坏性变更，请提升 PROTOCOL_VERSION：`);
      for (const issue of issues) console.error(`- ${issue.path}: ${issue.message}`);
      failed = true;
      continue;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, 'utf8');
  console.log(`Protocol schema 已更新：${relative(packageRoot, path)}`);
}

if (failed) process.exitCode = 1;
else if (mode === '--check') {
  console.log(`Protocol schema 检查通过：v${PROTOCOL_VERSION}，${contracts.length} 个产物`);
}

function contract(
  name: string,
  file: string,
  schema: z.ZodTypeAny
): { name: string; file: string; schema: z.ZodTypeAny } {
  return { name, file, schema };
}

function generateSchema(item: (typeof contracts)[number]): JsonSchema {
  const generated = zodToJsonSchema(item.schema, {
    name: item.name,
    target: 'jsonSchema7',
    $refStrategy: 'root'
  }) as JsonSchema;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://raw.githubusercontent.com/zzc-101/Kross/main/packages/protocol/schemas/${item.file}`,
    title: item.name,
    'x-kross-protocol-version': PROTOCOL_VERSION,
    ...generated
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
