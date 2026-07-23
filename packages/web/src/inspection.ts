export function traceRunIds(content: string): string[] {
  const ids = new Set<string>();
  for (const line of content.split('\n')) {
    const listMatch = line.match(/^\d+\.\s+([A-Za-z0-9._-]+)/);
    if (listMatch?.[1]) ids.add(listMatch[1]);
    const detailMatch = line.match(/^Trace:\s+([A-Za-z0-9._-]+)/);
    if (detailMatch?.[1]) ids.add(detailMatch[1]);
  }
  return [...ids];
}

export function diffLineKind(
  line: string
): 'addition' | 'deletion' | 'hunk' | 'meta' | 'context' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'addition';
  if (line.startsWith('-')) return 'deletion';
  if (line.startsWith('@@')) return 'hunk';
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('# ')
  ) {
    return 'meta';
  }
  return 'context';
}
