/**
 * 把工具入参格式化成 TUI / 审批面板可读的短预览。
 * Edit/Write 突出 path 与变更片段，避免整文件 JSON 糊屏。
 */

const DEFAULT_MAX = 500;

export function formatToolInputPreview(
  toolName: string | undefined,
  input: unknown,
  maxChars = DEFAULT_MAX
): string {
  if (input === undefined || input === null) {
    return '';
  }

  if (typeof input === 'string') {
    return truncate(input, maxChars);
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    try {
      return truncate(JSON.stringify(input), maxChars);
    } catch {
      return truncate(String(input), maxChars);
    }
  }

  const record = input as Record<string, unknown>;
  const name = toolName ?? '';

  if (name === 'Edit' || name === 'Write') {
    return truncate(formatFileMutationPreview(name, record), maxChars);
  }

  if (name === 'Delete' && typeof record.path === 'string') {
    const rec = record.recursive === true ? ' · recursive' : '';
    return truncate(`delete ${record.path}${rec}`, maxChars);
  }

  if (name === 'Move') {
    const from = typeof record.from === 'string' ? record.from : '?';
    const to = typeof record.to === 'string' ? record.to : '?';
    return truncate(`${from} → ${to}`, maxChars);
  }

  if (name === 'Bash' && typeof record.command === 'string') {
    return truncate(`$ ${record.command}`, maxChars);
  }

  if (name === 'Task') {
    const title =
      typeof record.description === 'string' && record.description.trim()
        ? record.description.trim()
        : typeof record.title === 'string'
          ? record.title.trim()
          : '';
    if (title) {
      return truncate(title, maxChars);
    }
  }

  if (typeof record.path === 'string') {
    const path = record.path;
    const extra =
      typeof record.pattern === 'string'
        ? ` pattern=${record.pattern}`
        : typeof record.glob === 'string'
          ? ` glob=${record.glob}`
          : '';
    return truncate(`${path}${extra}`, maxChars);
  }

  try {
    return truncate(JSON.stringify(input), maxChars);
  } catch {
    return truncate(String(input), maxChars);
  }
}

function formatFileMutationPreview(
  toolName: 'Edit' | 'Write',
  record: Record<string, unknown>
): string {
  const path =
    typeof record.path === 'string' && record.path.length > 0
      ? record.path
      : '(no path)';

  if (toolName === 'Write') {
    const content = typeof record.content === 'string' ? record.content : '';
    const lines = content.length === 0 ? 0 : content.replace(/\n$/, '').split('\n').length;
    const first = firstNonEmptyLine(content);
    const parts = [`${path}`, `${lines} lines`];
    if (first) {
      parts.push(clipLine(first, 80));
    }
    return parts.join(' · ');
  }

  // Edit：支持 edits[] 多处
  if (Array.isArray(record.edits) && record.edits.length > 0) {
    const count = record.edits.length;
    const first = record.edits[0] as Record<string, unknown> | undefined;
    const oldStr = typeof first?.old_string === 'string' ? first.old_string : '';
    const newStr = typeof first?.new_string === 'string' ? first.new_string : '';
    const oldLine = clipLine(
      firstNonEmptyLine(oldStr) || oldStr.replace(/\s+/g, ' '),
      50
    );
    const newLine = clipLine(
      firstNonEmptyLine(newStr) || newStr.replace(/\s+/g, ' '),
      50
    );
    return `${path} · ${count} edits\n- ${oldLine}\n+ ${newLine}`;
  }

  const oldStr = typeof record.old_string === 'string' ? record.old_string : '';
  const newStr = typeof record.new_string === 'string' ? record.new_string : '';
  const replaceAll = record.replace_all === true ? ' · replace_all' : '';
  const oldLine = clipLine(firstNonEmptyLine(oldStr) || oldStr.replace(/\s+/g, ' '), 60);
  const newLine = clipLine(firstNonEmptyLine(newStr) || newStr.replace(/\s+/g, ' '), 60);
  return `${path}${replaceAll}\n- ${oldLine}\n+ ${newLine}`;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) {
      return line;
    }
  }
  return '';
}

function clipLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
