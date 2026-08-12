import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

export type CollectedArtifactKind =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'data'
  | 'code'
  | 'archive'
  | 'other';

export interface CollectedArtifact {
  absolutePath: string;
  relativePath: string;
  displayName: string;
  kind: CollectedArtifactKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Discovers regular output files without following symlinks. Hashing is streamed
 * so a large deliverable never becomes an event payload or an in-memory buffer.
 */
export async function collectOutputArtifacts(input: {
  outputDirectory: string;
  maxTotalBytes: number;
  maxFiles?: number;
  signal?: AbortSignal;
}): Promise<CollectedArtifact[]> {
  if (!isAbsolute(input.outputDirectory)) throw new Error('Artifact output directory must be absolute');
  if (!Number.isSafeInteger(input.maxTotalBytes) || input.maxTotalBytes < 0) throw new Error('Artifact byte limit is invalid');
  const root = resolve(input.outputDirectory);
  const paths = await walk(root, root, input.maxFiles ?? 1_000, input.signal);
  const artifacts: CollectedArtifact[] = [];
  let totalBytes = 0;
  for (const absolutePath of paths.sort()) {
    throwIfAborted(input.signal);
    const info = await lstat(absolutePath);
    totalBytes += info.size;
    if (totalBytes > input.maxTotalBytes) throw new Error(`Artifact output exceeds ${input.maxTotalBytes} bytes`);
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    const descriptor = describeArtifact(relativePath);
    artifacts.push({
      absolutePath,
      relativePath,
      displayName: relativePath,
      ...descriptor,
      sizeBytes: info.size,
      sha256: await hashFile(absolutePath, input.signal)
    });
  }
  return artifacts;
}

async function walk(root: string, directory: string, maxFiles: number, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    const path = resolve(directory, entry.name);
    assertWithin(root, path);
    if (entry.isSymbolicLink()) throw new Error(`Artifact output contains a symbolic link: ${relative(root, path)}`);
    if (entry.isDirectory()) files.push(...await walk(root, path, maxFiles - files.length, signal));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Artifact output contains an unsupported file: ${relative(root, path)}`);
    if (files.length > maxFiles) throw new Error(`Artifact output exceeds ${maxFiles} files`);
  }
  return files;
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  const abort = () => stream.destroy(abortError(signal));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Unsafe artifact path');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

function describeArtifact(path: string): { kind: CollectedArtifactKind; mimeType: string } {
  const extension = extname(path).toLowerCase();
  const known: Record<string, { kind: CollectedArtifactKind; mimeType: string }> = {
    '.md': { kind: 'document', mimeType: 'text/markdown' },
    '.txt': { kind: 'document', mimeType: 'text/plain' },
    '.pdf': { kind: 'document', mimeType: 'application/pdf' },
    '.docx': { kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    '.csv': { kind: 'spreadsheet', mimeType: 'text/csv' },
    '.xlsx': { kind: 'spreadsheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    '.pptx': { kind: 'presentation', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    '.json': { kind: 'data', mimeType: 'application/json' },
    '.png': { kind: 'image', mimeType: 'image/png' },
    '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
    '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
    '.webp': { kind: 'image', mimeType: 'image/webp' },
    '.svg': { kind: 'image', mimeType: 'image/svg+xml' },
    '.zip': { kind: 'archive', mimeType: 'application/zip' },
    '.tar': { kind: 'archive', mimeType: 'application/x-tar' },
    '.js': { kind: 'code', mimeType: 'text/javascript' },
    '.ts': { kind: 'code', mimeType: 'text/plain' },
    '.py': { kind: 'code', mimeType: 'text/x-python' },
    '.html': { kind: 'code', mimeType: 'text/html' }
  };
  return known[extension] ?? { kind: 'other', mimeType: 'application/octet-stream' };
}
