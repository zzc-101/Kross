import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface MaterializableSource {
  id: string;
  kind: string;
  displayName: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  downloadHeaders: Array<{ name: string; value: string }>;
  expiresAt?: string;
}

export interface MaterializableRunSpec {
  runId: string;
  sources: MaterializableSource[];
  repository?: unknown;
  resourceLimits?: { maxSourceBytes: number };
}

export interface SourceDownloadAdapter {
  /** Implementations must stream to destination and honor the abort signal. */
  downloadToFile(input: {
    source: MaterializableSource;
    destination: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface MaterializedWorkspace {
  root: string;
  inputDirectory: string;
  outputDirectory: string;
  checkpointDirectory: string;
  repositoryDirectory?: string;
  manifestPath: string;
}

export async function materializeExecutionWorkspace(input: {
  runSpec: MaterializableRunSpec;
  physicalRoot: string;
  downloader: SourceDownloadAdapter;
  signal?: AbortSignal;
}): Promise<MaterializedWorkspace> {
  if (!isAbsolute(input.physicalRoot)) {
    throw new Error('Execution workspace root must be absolute');
  }
  const root = resolve(input.physicalRoot);
  const inputDirectory = safeJoin(root, 'input');
  const outputDirectory = safeJoin(root, 'output');
  const checkpointDirectory = safeJoin(root, 'checkpoint');
  const repositoryDirectory = input.runSpec.repository
    ? safeJoin(root, 'repository')
    : undefined;
  await Promise.all([
    mkdir(safeJoin(inputDirectory, 'sources'), { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(checkpointDirectory, { recursive: true }),
    repositoryDirectory ? mkdir(repositoryDirectory, { recursive: true }) : Promise.resolve()
  ]);

  const manifestSources: Array<Record<string, unknown>> = [];
  const totalSourceBytes = input.runSpec.sources.reduce((total, source) => total + source.sizeBytes, 0);
  if (input.runSpec.resourceLimits && totalSourceBytes > input.runSpec.resourceLimits.maxSourceBytes) {
    throw new Error(`Sources exceed ${input.runSpec.resourceLimits.maxSourceBytes} bytes`);
  }
  for (const source of input.runSpec.sources) {
    if (input.signal?.aborted) throw abortError(input.signal);
    if (source.expiresAt && Date.parse(source.expiresAt) <= Date.now()) throw new Error(`Source ${source.id} download instruction has expired`);
    const destination = safeJoin(inputDirectory, 'sources', source.id, source.fileName);
    await mkdir(dirname(destination), { recursive: true });
    await input.downloader.downloadToFile({ source, destination, signal: input.signal });
    const info = await stat(destination);
    if (!info.isFile() || info.size !== source.sizeBytes) {
      throw new Error(`Source ${source.id} size mismatch`);
    }
    const sha256 = await hashFile(destination, input.signal);
    if (sha256 !== source.sha256) {
      throw new Error(`Source ${source.id} sha256 mismatch`);
    }
    manifestSources.push({
      id: source.id,
      kind: source.kind,
      displayName: source.displayName,
      originalFileName: source.fileName,
      mimeType: source.mimeType,
      sizeBytes: source.sizeBytes,
      sha256: source.sha256,
      relativePath: relative(root, destination)
    });
  }
  const manifestPath = safeJoin(inputDirectory, 'manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 1, runId: input.runSpec.runId, sources: manifestSources }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return {
    root,
    inputDirectory,
    outputDirectory,
    checkpointDirectory,
    repositoryDirectory,
    manifestPath
  };
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  const abort = () => stream.destroy(signal ? abortError(signal) : new Error('Operation aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export function safeJoin(root: string, ...segments: string[]): string {
  const canonicalRoot = resolve(root);
  const candidate = resolve(canonicalRoot, ...segments);
  const rel = relative(canonicalRoot, candidate);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Unsafe workspace path');
  }
  return candidate;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}
