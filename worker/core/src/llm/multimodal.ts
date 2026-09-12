import type { LlmFetch, LlmImagePart, LlmMessage } from './types';

export const MAX_RESOLVED_IMAGE_BYTES = 10 * 1024 * 1024;

export const UNSUPPORTED_IMAGE_NOTE = (count: number): string =>
  `（当前模型不支持看图，已忽略 ${count} 张附件）`;

export function parseImageParts(value: unknown): LlmImagePart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const images: LlmImagePart[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const part = item as Record<string, unknown>;
    if (part.kind === 'url' && typeof part.url === 'string' && part.url.trim()) {
      const mimeType =
        typeof part.mimeType === 'string' && part.mimeType.trim()
          ? part.mimeType.trim()
          : undefined;
      images.push({
        kind: 'url',
        url: part.url.trim(),
        ...(mimeType ? { mimeType } : {})
      });
      continue;
    }
    if (
      part.kind === 'base64' &&
      typeof part.data === 'string' &&
      part.data.trim() &&
      typeof part.mimeType === 'string' &&
      part.mimeType.trim()
    ) {
      images.push({
        kind: 'base64',
        data: part.data.trim(),
        mimeType: part.mimeType.trim()
      });
      continue;
    }
    if (
      part.kind === 'workspace' &&
      typeof part.path === 'string' &&
      part.path.trim()
    ) {
      const mimeType =
        typeof part.mimeType === 'string' && part.mimeType.trim()
          ? part.mimeType.trim()
          : undefined;
      images.push({
        kind: 'workspace',
        path: part.path.trim(),
        ...(mimeType ? { mimeType } : {})
      });
    }
  }
  return images;
}

export function imageCount(message: LlmMessage): number {
  return message.role === 'tool' ? 0 : message.images?.length ?? 0;
}

export function applyMultimodalReadPolicy(
  messages: LlmMessage[],
  multimodalRead: boolean
): LlmMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool' || !message.images?.length) {
      return message;
    }
    if (multimodalRead && message.role === 'user') {
      return message;
    }
    const note = UNSUPPORTED_IMAGE_NOTE(message.images.length);
    const content = message.content.trim()
      ? `${message.content}\n${note}`
      : note;
    return {
      role: message.role,
      content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {})
    };
  });
}

export function hasRemoteUrlImages(messages: LlmMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'user' || !message.images?.length) {
      return false;
    }
    return message.images.some(
      (image) => image.kind === 'url' && !parseDataUrl(image.url)
    );
  });
}

/**
 * pi-ai ImageContent only accepts base64. Download http(s) URLs first;
 * leftover remote URLs are dropped by {@link dropRemoteUrlImages}.
 */
export async function resolveRemoteImages(
  messages: LlmMessage[],
  fetchImpl: LlmFetch,
  signal?: AbortSignal
): Promise<LlmMessage[]> {
  if (!hasRemoteUrlImages(messages)) {
    return messages;
  }

  return Promise.all(
    messages.map(async (message) => {
      if (message.role !== 'user' || !message.images?.length) {
        return message;
      }
      const images: LlmImagePart[] = [];
      for (const image of message.images) {
        if (image.kind === 'base64' || parseDataUrl(image.url)) {
          images.push(image);
          continue;
        }
        images.push(
          (await fetchRemoteImage(image, fetchImpl, signal)) ?? image
        );
      }
      return { ...message, images };
    })
  );
}

/** Drop remote URLs that could not be converted to base64 for pi-ai. */
export function dropRemoteUrlImages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.images?.length) {
      return message;
    }
    const kept = message.images.filter(
      (image) => image.kind === 'base64' || Boolean(parseDataUrl(image.url))
    );
    const dropped = message.images.length - kept.length;
    if (dropped === 0) {
      return message;
    }
    const note = UNSUPPORTED_IMAGE_NOTE(dropped);
    const content = message.content.trim()
      ? `${message.content}\n${note}`
      : note;
    return {
      role: 'user',
      content,
      ...(kept.length > 0 ? { images: kept } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {})
    };
  });
}

export function toPiImageContent(
  image: LlmImagePart
): { type: 'image'; data: string; mimeType: string } | undefined {
  if (image.kind === 'base64') {
    return { type: 'image', data: image.data, mimeType: image.mimeType };
  }
  const parsed = parseDataUrl(image.url);
  if (!parsed) {
    return undefined;
  }
  return { type: 'image', data: parsed.data, mimeType: parsed.mimeType };
}

export function parseDataUrl(
  url: string
): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url.trim());
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { mimeType: match[1], data: match[2] };
}

async function fetchRemoteImage(
  image: Extract<LlmImagePart, { kind: 'url' }>,
  fetchImpl: LlmFetch,
  signal?: AbortSignal
): Promise<LlmImagePart | undefined> {
  if (!isHttpUrl(image.url)) {
    return undefined;
  }
  try {
    const response = await fetchImpl(image.url, { signal });
    if (!response.ok) {
      return undefined;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESOLVED_IMAGE_BYTES) {
      return undefined;
    }
    const header = response.headers.get('content-type')?.split(';')[0]?.trim();
    const mimeType =
      header?.startsWith('image/')
        ? header
        : image.mimeType?.trim() || 'image/png';
    return {
      kind: 'base64',
      data: Buffer.from(bytes).toString('base64'),
      mimeType
    };
  } catch {
    return undefined;
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
