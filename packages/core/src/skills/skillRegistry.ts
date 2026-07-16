import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import {
  discoverSkills,
  type DiscoverSkillsInput,
  type SkillDescriptor,
  type SkillsSnapshot
} from './skillDiscovery';

export interface SkillRegistryOptions {
  getRoots: () => DiscoverSkillsInput['roots'];
  personalSkillsDir?: string;
  maxReadBytes?: number;
}

export interface ReadSkillInput {
  id: string;
  rootId?: string;
  resource?: string;
  offset?: number;
  limit?: number;
}

export interface ReadSkillResult {
  skill: SkillDescriptor;
  resource: string;
  content: string;
  originalBytes: number;
  injectedBytes: number;
  truncated: boolean;
}

const DECODER = new TextDecoder('utf-8', { fatal: true });

export class SkillRegistry {
  private snapshot: SkillsSnapshot = discoverSkills({ roots: [] });

  constructor(private readonly options: SkillRegistryOptions) {}

  refresh(): SkillsSnapshot {
    this.snapshot = discoverSkills({
      roots: this.options.getRoots(),
      personalSkillsDir: this.options.personalSkillsDir
    });
    return this.snapshot;
  }

  getSnapshot(): SkillsSnapshot {
    return this.snapshot;
  }

  resolve(id: string, rootId?: string): SkillDescriptor {
    const snapshot = this.refresh();
    const normalized = id.trim();
    const project = rootId
      ? snapshot.skills.find(
          (skill) =>
            skill.id === normalized &&
            skill.scope === 'workspace' &&
            skill.rootId === rootId
        )
      : undefined;
    const personal = snapshot.skills.find(
      (skill) => skill.id === normalized && skill.scope === 'personal'
    );
    const unambiguousProject = !rootId
      ? snapshot.skills.filter(
          (skill) => skill.id === normalized && skill.scope === 'workspace'
        )
      : [];
    const resolved = project ?? personal ??
      (unambiguousProject.length === 1 ? unambiguousProject[0] : undefined);
    if (!resolved) {
      throw new Error(`Skill not found or ambiguous: ${normalized}`);
    }
    return resolved;
  }

  read(input: ReadSkillInput): ReadSkillResult {
    const skill = this.resolve(input.id, input.rootId);
    const resource = input.resource?.trim() || 'SKILL.md';
    const lexicalTarget = join(skill.directory, resource);
    const canonicalTarget = realpathSync(lexicalTarget);
    const pathFromRoot = relative(skill.directory, canonicalTarget);
    if (
      pathFromRoot === '..' ||
      pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(pathFromRoot)
    ) {
      throw new Error(`Resource resolves outside skill directory: ${resource}`);
    }
    if (!statSync(canonicalTarget).isFile()) {
      throw new Error(`Skill resource is not a regular file: ${resource}`);
    }
    const buffer = readFileSync(canonicalTarget);
    const decoded = DECODER.decode(buffer);
    const lines = decoded.split(/\r?\n/);
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(0, input.limit ?? lines.length);
    const selected = lines.slice(offset, offset + limit).join('\n');
    const selectedBuffer = Buffer.from(selected, 'utf8');
    const maxBytes = Math.max(0, this.options.maxReadBytes ?? 64 * 1024);
    const safe = safePrefix(selectedBuffer, maxBytes);
    return {
      skill,
      resource,
      content: DECODER.decode(safe),
      originalBytes: buffer.length,
      injectedBytes: safe.length,
      truncated: safe.length < selectedBuffer.length
    };
  }
}

function safePrefix(buffer: Buffer, maxBytes: number): Buffer {
  let end = Math.min(buffer.length, maxBytes);
  while (end > 0) {
    const slice = buffer.subarray(0, end);
    try {
      DECODER.decode(slice);
      return slice;
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}
