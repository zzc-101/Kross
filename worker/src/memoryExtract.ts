import { createLlmClientFromEnv } from '../core/src/llm/createLlmClient';

export type ExtractedMemory = {
  kind: 'preference' | 'fact';
  content: string;
};

const EXTRACT_PROMPT = [
  'You extract durable personal memories from USER messages only.',
  'Ignore assistant replies. Do not copy chat transcripts.',
  'Return JSON only: {"items":[{"kind":"preference"|"fact","content":"..."}]}',
  'kind=preference: how to address the user, language, coding/style habits.',
  'kind=fact: stable projects, people, decisions, long-lived constraints.',
  'Skip greetings, one-off tasks, secrets, and anything already listed in existing or forgotten.',
  'Each content must be one short sentence, max 200 characters.',
  'If nothing durable is present, return {"items":[]}.'
].join('\n');

export async function extractMemories(
  env: Record<string, string | undefined>,
  payload: Record<string, unknown>
): Promise<{ items: ExtractedMemory[] }> {
  const userMessages = stringList(payload.userMessages);
  if (userMessages.length === 0) {
    return { items: [] };
  }
  const client = createLlmClientFromEnv(env);
  if (!client) {
    return { items: [] };
  }
  const existing = JSON.stringify(payload.existing ?? []);
  const forgotten = JSON.stringify(payload.forgotten ?? []);
  const response = await client.complete({
    temperature: 0,
    maxTokens: 800,
    messages: [
      { role: 'system', content: EXTRACT_PROMPT },
      {
        role: 'user',
        content: [
          'Existing memories:',
          existing,
          '',
          'Forgotten memories (do not restore):',
          forgotten,
          '',
          'User messages since last extract:',
          userMessages.map((item, index) => `${index + 1}. ${item}`).join('\n')
        ].join('\n')
      }
    ]
  });
  return { items: parseExtractedItems(response.text) };
}

export function parseExtractedItems(text: string): ExtractedMemory[] {
  const json = extractJsonObject(text);
  if (!json || !Array.isArray(json.items)) {
    return [];
  }
  const items: ExtractedMemory[] = [];
  for (const raw of json.items) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.replace(/\s+/g, ' ').trim() : '';
    if (!content || content.length > 400) continue;
    const kind = record.kind === 'preference' ? 'preference' : 'fact';
    items.push({ kind, content });
  }
  return items;
}

function extractJsonObject(text: string): { items?: unknown } | undefined {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as { items?: unknown };
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.replace(/\s+/g, ' ').trim());
}
