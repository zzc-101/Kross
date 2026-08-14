import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ProjectInstructionRoot } from '../workspace/projectInstructions';

export interface SkillDescriptor {
  descriptorId: string;
  id: string;
  name: string;
  description: string;
  rootId: string | 'personal';
  scope: 'personal' | 'workspace';
  directory: string;
  entryPath: string;
  precedence: number;
}

export type SkillDiagnosticCode =
  | 'outside-root'
  | 'not-file'
  | 'read-failed'
  | 'invalid'
  | 'limit';

export interface SkillDiagnostic {
  rootId: string;
  path: string;
  code: SkillDiagnosticCode;
  message: string;
}

export interface SkillsSnapshot {
  skills: SkillDescriptor[];
  diagnostics: SkillDiagnostic[];
  signature: string;
}

export interface DiscoverSkillsInput {
  roots: ProjectInstructionRoot[];
  personalSkillsDir?: string;
  maxSkills?: number;
  maxDescriptionBytes?: number;
}

const DEFAULT_MAX_SKILLS = 64;
const DEFAULT_MAX_DESCRIPTION_BYTES = 1024;
const DECODER = new TextDecoder('utf-8', { fatal: true });

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path));
}

function diagnostic(
  rootId: string,
  path: string,
  code: SkillDiagnosticCode,
  message: string
): SkillDiagnostic {
  return { rootId, path, code, message };
}

function parseMetadata(content: string, id: string): {
  name: string;
  description: string;
} {
  let body = content;
  const metadata = new Map<string, string>();
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const lines = content.split(/\r?\n/);
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closing > 0) {
      for (const line of lines.slice(1, closing)) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
        if (match) {
          metadata.set(match[1]!.toLowerCase(), unquote(match[2]!.trim()));
        }
      }
      body = lines.slice(closing + 1).join('\n');
    }
  }
  const fallback = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  return {
    name: metadata.get('name')?.trim() || id,
    description:
      metadata.get('description')?.trim() || fallback || `Skill ${id}`
  };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function truncateDescription(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) {
    return value;
  }
  let end = Math.max(0, maxBytes - Buffer.byteLength('…'));
  while (end > 0) {
    try {
      return `${DECODER.decode(buffer.subarray(0, end))}…`;
    } catch {
      end -= 1;
    }
  }
  return '';
}

function scanSkillsDirectory(input: {
  skillsDir: string;
  allowedRoot: string;
  rootId: string;
  scope: 'personal' | 'workspace';
  precedence: number;
  maxDescriptionBytes: number;
  skills: SkillDescriptor[];
  diagnostics: SkillDiagnostic[];
}): void {
  const skillsDir = resolve(input.skillsDir);
  let canonicalSkillsDir: string;
  let entries: Dirent<string>[];
  try {
    canonicalSkillsDir = realpathSync(skillsDir);
    const canonicalAllowedRoot = realpathSync(input.allowedRoot);
    if (!within(canonicalAllowedRoot, canonicalSkillsDir)) {
      input.diagnostics.push(
        diagnostic(input.rootId, skillsDir, 'outside-root', 'Skills directory resolves outside its allowed root')
      );
      return;
    }
    entries = readdirSync(skillsDir, {
      withFileTypes: true,
      encoding: 'utf8'
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      input.diagnostics.push(
        diagnostic(input.rootId, skillsDir, 'read-failed', `Cannot scan skills: ${String(error)}`)
      );
    }
    return;
  }

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const id = entry.name.trim();
    if (!id || id === '.' || id === '..') {
      continue;
    }
    const directory = join(skillsDir, entry.name);
    const entryPath = join(directory, 'SKILL.md');
    try {
      const canonicalDirectory = realpathSync(directory);
      if (!within(canonicalSkillsDir, canonicalDirectory)) {
        input.diagnostics.push(
          diagnostic(input.rootId, entryPath, 'outside-root', 'Skill directory resolves outside skills root')
        );
        continue;
      }
      const canonicalEntry = realpathSync(entryPath);
      if (!within(canonicalDirectory, canonicalEntry)) {
        input.diagnostics.push(
          diagnostic(input.rootId, entryPath, 'outside-root', 'SKILL.md resolves outside skill directory')
        );
        continue;
      }
      if (!statSync(canonicalEntry).isFile()) {
        input.diagnostics.push(
          diagnostic(input.rootId, entryPath, 'not-file', 'SKILL.md is not a regular file')
        );
        continue;
      }
      const content = DECODER.decode(readFileSync(canonicalEntry));
      const parsed = parseMetadata(content, id);
      input.skills.push({
        descriptorId:
          input.scope === 'personal'
            ? `personal:${id}`
            : `workspace:${input.rootId}:${id}`,
        id,
        name: parsed.name,
        description: truncateDescription(parsed.description, input.maxDescriptionBytes),
        rootId: input.scope === 'personal' ? 'personal' : input.rootId,
        scope: input.scope,
        directory: canonicalDirectory,
        entryPath: canonicalEntry,
        precedence: input.precedence
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        input.diagnostics.push(
          diagnostic(input.rootId, entryPath, 'read-failed', `Cannot read skill: ${String(error)}`)
        );
      }
    }
  }
}

export function discoverSkills(input: DiscoverSkillsInput): SkillsSnapshot {
  const skills: SkillDescriptor[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const maxDescriptionBytes = Math.max(
    0,
    input.maxDescriptionBytes ?? DEFAULT_MAX_DESCRIPTION_BYTES
  );
  if (input.personalSkillsDir) {
    scanSkillsDirectory({
      skillsDir: input.personalSkillsDir,
      allowedRoot: input.personalSkillsDir,
      rootId: 'personal',
      scope: 'personal',
      precedence: 10,
      maxDescriptionBytes,
      skills,
      diagnostics
    });
  }
  for (const root of input.roots) {
    scanSkillsDirectory({
      skillsDir: join(root.path, '.agents', 'skills'),
      allowedRoot: root.path,
      rootId: root.id,
      scope: 'workspace',
      precedence: 20,
      maxDescriptionBytes,
      skills,
      diagnostics
    });
  }

  const maxSkills = Math.max(0, input.maxSkills ?? DEFAULT_MAX_SKILLS);
  const allocated = [...skills]
    .sort((a, b) => b.precedence - a.precedence)
    .slice(0, maxSkills);
  const selectedIds = new Set(allocated.map((skill) => skill.descriptorId));
  const selected = skills.filter((skill) => selectedIds.has(skill.descriptorId));
  for (const skill of skills.filter((skill) => !selectedIds.has(skill.descriptorId))) {
    diagnostics.push(
      diagnostic(skill.rootId, skill.entryPath, 'limit', `Skipped because the ${maxSkills}-skill limit was reached`)
    );
  }
  const signature = createHash('sha256')
    .update(JSON.stringify({ skills: selected, diagnostics }))
    .digest('hex');
  return { skills: selected, diagnostics, signature };
}
