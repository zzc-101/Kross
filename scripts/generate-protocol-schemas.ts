import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import {
  PROTOCOL_VERSION,
  clientCommandSchema,
  eventEnvelopeSchema,
  serverEventSchema
} from '../packages/protocol/src/schemas';
import {
  findBreakingSchemaChanges,
  type JsonSchema
} from '../packages/protocol/src/jsonSchemaCompatibility';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';

const root = process.cwd();
const outputDirectory = join(root, 'docs', 'schemas');
const mode = process.argv[2];

if (mode !== '--check' && mode !== '--update') {
  throw new Error(
    '用法: tsx scripts/generate-protocol-schemas.ts <--check|--update>'
  );
}

const contracts = [
  {
    name: `KrossClientCommandV${PROTOCOL_VERSION}`,
    file: `kross-client-command-v${PROTOCOL_VERSION}.schema.json`,
    description: 'Commands accepted by the Kross Cloud Gateway and Worker.',
    schema: clientCommandSchema
  },
  {
    name: `KrossServerEventV${PROTOCOL_VERSION}`,
    file: `kross-server-event-v${PROTOCOL_VERSION}.schema.json`,
    description: 'Events emitted by a Kross Cloud Gateway or Worker.',
    schema: serverEventSchema
  },
  {
    name: `KrossEventEnvelopeV${PROTOCOL_VERSION}`,
    file: `kross-event-envelope-v${PROTOCOL_VERSION}.schema.json`,
    description: 'Sequenced Kross Cloud event envelope used for replay.',
    schema: eventEnvelopeSchema
  }
] satisfies Array<{
  name: string;
  file: string;
  description: string;
  schema: z.ZodTypeAny;
}>;

let failed = false;
for (const contract of contracts) {
  const path = join(outputDirectory, contract.file);
  const generated = generateSchema(contract);
  const serialized = `${JSON.stringify(generated, null, 2)}\n`;
  const existingText = await readOptional(path);

  if (existingText === serialized) {
    continue;
  }

  if (mode === '--check') {
    console.error(`Protocol schema 未同步：${relative(root, path)}`);
    failed = true;
    continue;
  }

  if (existingText) {
    const existing = JSON.parse(existingText) as JsonSchema;
    const issues = findBreakingSchemaChanges(existing, generated);
    if (issues.length > 0) {
      console.error(
        `${contract.file} 存在破坏性变更；请提升 PROTOCOL_VERSION 后生成新文件：`
      );
      for (const issue of issues) {
        console.error(`- ${issue.path}: ${issue.message}`);
      }
      failed = true;
      continue;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, 'utf8');
  console.log(`Protocol schema 已更新：${relative(root, path)}`);
}

if (failed) {
  process.exitCode = 1;
} else if (mode === '--check') {
  console.log(
    `Protocol schema 检查通过：v${PROTOCOL_VERSION}，${contracts.length} 个产物`
  );
}

function generateSchema(contract: (typeof contracts)[number]): JsonSchema {
  const generated = zodToJsonSchema(contract.schema, {
    name: contract.name,
    target: 'jsonSchema7',
    $refStrategy: 'root'
  }) as JsonSchema;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://raw.githubusercontent.com/zzc-101/Kross/main/docs/schemas/${contract.file}`,
    title: contract.name,
    description: contract.description,
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
