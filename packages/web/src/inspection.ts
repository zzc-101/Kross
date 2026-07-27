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

export interface TracePresentation {
  kind: 'list' | 'detail' | 'replay';
  runId?: string;
  facts: Array<{ label: string; value: string }>;
  sections: Array<{ title: string; lines: string[] }>;
}

export function parseTracePresentation(content: string): TracePresentation {
  const lines = content.split('\n');
  const detailMatch = lines[0]?.match(/^Trace:\s+([A-Za-z0-9._-]+)/);
  const replayMatch = lines[0]?.match(/^### Trace Replay[：:]\s*([A-Za-z0-9._-]+)/);
  const kind: TracePresentation['kind'] = detailMatch
    ? 'detail'
    : replayMatch
      ? 'replay'
      : 'list';
  const facts: TracePresentation['facts'] = [];
  const sections: TracePresentation['sections'] = [];
  let section: TracePresentation['sections'][number] | undefined;

  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^###?\s+(.+)/);
    if (heading?.[1]) {
      section = { title: heading[1], lines: [] };
      sections.push(section);
      continue;
    }
    const plainHeading = line.match(/^([A-Za-z][A-Za-z ]+):$/);
    if (plainHeading?.[1]) {
      section = { title: plainHeading[1], lines: [] };
      sections.push(section);
      continue;
    }
    const fact = line.match(/^-?\s*([A-Za-z][A-Za-z _-]*):\s*(.+)$/);
    if (!section && fact?.[1] && fact[2]) {
      facts.push({ label: fact[1].trim(), value: fact[2].trim() });
      continue;
    }
    if (!section) {
      section = {
        title: kind === 'list' ? 'Runs' : kind === 'replay' ? 'Replay' : 'Events',
        lines: []
      };
      sections.push(section);
    }
    section.lines.push(rawLine);
  }

  return {
    kind,
    runId: detailMatch?.[1] ?? replayMatch?.[1],
    facts,
    sections
  };
}

export function traceLineKind(
  line: string
): 'error' | 'warning' | 'normal' {
  if (/\b(error|failed|failure|rate-limit(?:ed)?|network|timeout|aborted)\b/i.test(line)) {
    return 'error';
  }
  if (/\b(retry|warning|unknown|unpriced)\b/i.test(line)) return 'warning';
  return 'normal';
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
