import type { SubagentRunOutcome } from './subagentTypes';

export function formatSubagentToolContent(outcome: SubagentRunOutcome): string {
  const { result, subRunId, mode } = outcome;
  const lines = [
    `Subagent ${mode} (${subRunId}) → ${result.status}`,
    outcome.modelProfileId
      ? `Model profile: ${outcome.modelProfileName ?? outcome.modelProfileId} (${outcome.modelProfileId})${outcome.model ? ` · ${outcome.model}` : ''}`
      : outcome.model
        ? `Model: ${outcome.model}`
        : undefined,
    '',
    result.summary,
    result.evidence.length > 0
      ? `\nEvidence:\n${result.evidence.map((item) => `- ${item}`).join('\n')}`
      : undefined,
    result.incompleteItems.length > 0
      ? `\nIncomplete items:\n${result.incompleteItems.map((item) => `- ${item}`).join('\n')}`
      : undefined,
    result.artifacts.length > 0
      ? `\nArtifacts:\n${result.artifacts.map((item) => `- ${item}`).join('\n')}`
      : undefined,
    result.toolsUsed.length > 0
      ? `Tools used: ${result.toolsUsed.join(', ')}`
      : undefined
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}
