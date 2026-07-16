import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const PROJECT_INSTRUCTION_FILENAMES = [
  'CLAUDE.md',
  'AGENTS.md',
  'KROSS.md'
] as const;

export type ProjectInstructionFilename =
  (typeof PROJECT_INSTRUCTION_FILENAMES)[number];

export interface ProjectInstructionRoot {
  id: string;
  path: string;
  primary: boolean;
}

export interface ProjectInstructionFile {
  sourceId: string;
  rootId: string;
  rootPath: string;
  rootPrimary: boolean;
  filename: ProjectInstructionFilename;
  path: string;
  relativePath: string;
  precedence: number;
  content: string;
  originalBytes: number;
  injectedBytes: number;
  truncated: boolean;
}

export type ProjectInstructionDiagnosticCode =
  | 'outside-root'
  | 'not-file'
  | 'read-failed'
  | 'empty'
  | 'file-limit'
  | 'total-limit';

export interface ProjectInstructionDiagnostic {
  rootId: string;
  path: string;
  code: ProjectInstructionDiagnosticCode;
  message: string;
}

export interface ProjectInstructionsSnapshot {
  files: ProjectInstructionFile[];
  diagnostics: ProjectInstructionDiagnostic[];
  totalOriginalBytes: number;
  totalInjectedBytes: number;
  signature: string;
}

export interface LoadProjectInstructionsInput {
  roots: ProjectInstructionRoot[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const DEFAULT_MAX_FILES = 16;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const PRECEDENCE: Record<ProjectInstructionFilename, number> = {
  'CLAUDE.md': 10,
  'AGENTS.md': 20,
  'KROSS.md': 30
};

interface Candidate {
  root: ProjectInstructionRoot;
  rootPath: string;
  rootOrder: number;
  filename: ProjectInstructionFilename;
  path: string;
  content: Buffer;
}

function diagnostic(
  rootId: string,
  path: string,
  code: ProjectInstructionDiagnosticCode,
  message: string
): ProjectInstructionDiagnostic {
  return { rootId, path, code, message };
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
  );
}

function decodeUtf8(buffer: Buffer): string {
  return UTF8_DECODER.decode(buffer);
}

function decodeSafePrefix(buffer: Buffer, maxBytes: number): Buffer {
  let end = Math.min(buffer.length, Math.max(0, maxBytes));
  while (end > 0) {
    const slice = buffer.subarray(0, end);
    try {
      decodeUtf8(slice);
      return slice;
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}

function decodeSafeSuffix(buffer: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, buffer.length - Math.max(0, maxBytes));
  while (start < buffer.length) {
    const slice = buffer.subarray(start);
    try {
      decodeUtf8(slice);
      return slice;
    } catch {
      start += 1;
    }
  }
  return Buffer.alloc(0);
}

function truncateUtf8HeadTail(
  buffer: Buffer,
  maxBytes: number
): { content: string; bytes: number; truncated: boolean } {
  if (buffer.length <= maxBytes) {
    return {
      content: decodeUtf8(buffer),
      bytes: buffer.length,
      truncated: false
    };
  }

  const marker = Buffer.from(
    `\n\n[... project instructions truncated; original ${buffer.length} bytes ...]\n\n`,
    'utf8'
  );
  if (marker.length >= maxBytes) {
    const prefix = decodeSafePrefix(buffer, maxBytes);
    return {
      content: decodeUtf8(prefix),
      bytes: prefix.length,
      truncated: true
    };
  }

  const remaining = maxBytes - marker.length;
  const head = decodeSafePrefix(buffer, Math.ceil(remaining / 2));
  const tail = decodeSafeSuffix(buffer, remaining - head.length);
  const result = Buffer.concat([head, marker, tail]);
  return {
    content: decodeUtf8(result),
    bytes: result.length,
    truncated: true
  };
}

function orderedRoots(roots: ProjectInstructionRoot[]): ProjectInstructionRoot[] {
  return roots
    .map((root, index) => ({ root, index }))
    .sort((a, b) => {
      if (a.root.primary !== b.root.primary) {
        return a.root.primary ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map(({ root }) => root);
}

function signatureFor(
  files: ProjectInstructionFile[],
  diagnostics: ProjectInstructionDiagnostic[]
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        files: files.map((file) => ({
          sourceId: file.sourceId,
          rootPath: file.rootPath,
          path: file.path,
          content: file.content,
          originalBytes: file.originalBytes,
          injectedBytes: file.injectedBytes,
          truncated: file.truncated
        })),
        diagnostics
      })
    )
    .digest('hex');
}

export function loadProjectInstructions(
  input: LoadProjectInstructionsInput
): ProjectInstructionsSnapshot {
  const maxFiles = Math.max(0, input.maxFiles ?? DEFAULT_MAX_FILES);
  const maxFileBytes = Math.max(0, input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = Math.max(0, input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
  const roots = orderedRoots(input.roots);
  const diagnostics: ProjectInstructionDiagnostic[] = [];
  const candidates: Candidate[] = [];

  for (const [rootOrder, root] of roots.entries()) {
    const rootPath = resolve(root.path);
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(rootPath);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          root.id,
          rootPath,
          'read-failed',
          `Cannot resolve workspace root: ${String(error)}`
        )
      );
      continue;
    }

    for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
      const path = join(rootPath, filename);
      try {
        lstatSync(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          diagnostics.push(
            diagnostic(root.id, path, 'read-failed', `Cannot inspect file: ${String(error)}`)
          );
        }
        continue;
      }

      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(path);
      } catch (error) {
        diagnostics.push(
          diagnostic(root.id, path, 'read-failed', `Cannot resolve file: ${String(error)}`)
        );
        continue;
      }
      if (!isWithinRoot(canonicalRoot, canonicalPath)) {
        diagnostics.push(
          diagnostic(
            root.id,
            path,
            'outside-root',
            `Resolved path is outside workspace root: ${canonicalPath}`
          )
        );
        continue;
      }

      try {
        if (!statSync(canonicalPath).isFile()) {
          diagnostics.push(
            diagnostic(root.id, path, 'not-file', 'Instruction candidate is not a regular file')
          );
          continue;
        }
        const content = readFileSync(canonicalPath);
        if (content.length === 0) {
          diagnostics.push(
            diagnostic(root.id, path, 'empty', 'Instruction file is empty')
          );
          continue;
        }
        decodeUtf8(content);
        candidates.push({
          root,
          rootPath,
          rootOrder,
          filename,
          path,
          content
        });
      } catch (error) {
        diagnostics.push(
          diagnostic(
            root.id,
            path,
            'read-failed',
            `Cannot read UTF-8 instruction file: ${String(error)}`
          )
        );
      }
    }
  }

  const totalOriginalBytes = candidates.reduce(
    (total, candidate) => total + candidate.content.length,
    0
  );
  const allocationOrder = [...candidates].sort((a, b) => {
    if (a.rootOrder !== b.rootOrder) {
      return a.rootOrder - b.rootOrder;
    }
    return PRECEDENCE[b.filename] - PRECEDENCE[a.filename];
  });
  const selected: ProjectInstructionFile[] = [];
  let totalInjectedBytes = 0;

  for (const [index, candidate] of allocationOrder.entries()) {
    if (index >= maxFiles) {
      diagnostics.push(
        diagnostic(
          candidate.root.id,
          candidate.path,
          'file-limit',
          `Skipped because the ${maxFiles}-file instruction limit was reached`
        )
      );
      continue;
    }

    const truncated = truncateUtf8HeadTail(candidate.content, maxFileBytes);
    if (totalInjectedBytes + truncated.bytes > maxTotalBytes) {
      diagnostics.push(
        diagnostic(
          candidate.root.id,
          candidate.path,
          'total-limit',
          `Skipped because the ${maxTotalBytes}-byte total instruction limit was reached`
        )
      );
      continue;
    }

    selected.push({
      sourceId: `project-instruction:${candidate.root.id}:${candidate.filename}`,
      rootId: candidate.root.id,
      rootPath: candidate.rootPath,
      rootPrimary: candidate.root.primary,
      filename: candidate.filename,
      path: candidate.path,
      relativePath: candidate.filename,
      precedence: PRECEDENCE[candidate.filename],
      content: truncated.content,
      originalBytes: candidate.content.length,
      injectedBytes: truncated.bytes,
      truncated: truncated.truncated
    });
    totalInjectedBytes += truncated.bytes;
  }

  selected.sort((a, b) => {
    const rootDiff = roots.findIndex((root) => root.id === a.rootId) -
      roots.findIndex((root) => root.id === b.rootId);
    return rootDiff || a.precedence - b.precedence;
  });

  return {
    files: selected,
    diagnostics,
    totalOriginalBytes,
    totalInjectedBytes,
    signature: signatureFor(selected, diagnostics)
  };
}

export function formatProjectInstructionSource(
  file: ProjectInstructionFile
): string {
  const scope = file.rootPrimary
    ? `These instructions apply to the primary workspace root ${file.rootId}.`
    : `These instructions only applies to workspace root ${file.rootId}; do not apply them to other roots.`;
  return [
    'Project instructions',
    `scope: rootId=${file.rootId} root=${file.rootPath}`,
    `source: ${file.filename} (${file.path})`,
    `precedence=${file.precedence}; later project-instruction blocks override earlier blocks for the same root`,
    scope,
    '',
    file.content
  ].join('\n');
}
