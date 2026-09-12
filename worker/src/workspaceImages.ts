import { open, stat } from 'node:fs/promises';

import { resolveExistingPathWithinWorkspace } from '../core/src/tools/builtin/paths';
import {
  MAX_RESOLVED_IMAGE_BYTES,
  UNSUPPORTED_IMAGE_NOTE
} from '../core/src/llm/multimodal';
import type { ConversationHistoryTurn, LlmImagePart } from '../core/src/llm/types';

export async function materializeWorkspaceImageParts(
  workspaceRoot: string,
  images: LlmImagePart[] | undefined
): Promise<{ images: LlmImagePart[]; dropped: number }> {
  if (!images?.length) {
    return { images: [], dropped: 0 };
  }
  const next: LlmImagePart[] = [];
  let dropped = 0;
  for (const image of images) {
    if (image.kind !== 'workspace') {
      next.push(image);
      continue;
    }
    const resolved = await readWorkspaceImage(workspaceRoot, image);
    if (resolved) {
      next.push(resolved);
    } else {
      dropped += 1;
    }
  }
  return { images: next, dropped };
}

export async function materializeHistoryImages(
  workspaceRoot: string,
  history: ConversationHistoryTurn[]
): Promise<ConversationHistoryTurn[]> {
  const turns: ConversationHistoryTurn[] = [];
  for (const turn of history) {
    if (turn.role !== 'user' || !turn.images?.length) {
      turns.push(turn);
      continue;
    }
    const resolved = await materializeWorkspaceImageParts(workspaceRoot, turn.images);
    const content = resolved.dropped > 0
      ? appendImageNote(turn.content, resolved.dropped)
      : turn.content;
    turns.push({
      role: 'user',
      content,
      ...(resolved.images.length > 0 ? { images: resolved.images } : {})
    });
  }
  return turns;
}

export function appendImageNote(content: string, dropped: number): string {
  const note = UNSUPPORTED_IMAGE_NOTE(dropped);
  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n${note}` : note;
}

async function readWorkspaceImage(
  workspaceRoot: string,
  image: Extract<LlmImagePart, { kind: 'workspace' }>
): Promise<LlmImagePart | undefined> {
  try {
    const target = await resolveExistingPathWithinWorkspace(workspaceRoot, image.path);
    const info = await stat(target);
    if (!info.isFile() || info.size === 0 || info.size > MAX_RESOLVED_IMAGE_BYTES) {
      return undefined;
    }
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
      if (bytesRead === 0) {
        return undefined;
      }
      return {
        kind: 'base64',
        data: buffer.subarray(0, bytesRead).toString('base64'),
        mimeType: image.mimeType?.trim() || mimeFromPath(image.path)
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}
