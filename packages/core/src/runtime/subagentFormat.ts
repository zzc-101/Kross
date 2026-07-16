import type { SubagentRunOutcome } from './subagentTypes';

export function formatSubagentToolContent(outcome: SubagentRunOutcome): string {
  const { result, subRunId, mode } = outcome;
  const lines = [
    `Subagent ${mode} (${subRunId}) → ${result.status}`,
    '',
    result.summary,
    result.evidence.length > 0
      ? `\nEvidence:\n${result.evidence.map((item) => `- ${item}`).join('\n')}`
      : undefined,
    result.risks.length > 0
      ? `\nRisks:\n${result.risks.map((item) => `- ${item}`).join('\n')}`
      : undefined,
    result.changedFiles.length > 0
      ? `\nChanged files:\n${result.changedFiles.map((item) => `- ${item}`).join('\n')}`
      : undefined
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}
