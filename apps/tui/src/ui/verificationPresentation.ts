import {
  t,
  type VerificationReport,
  type VerificationStatus
} from '@kross/core';

export interface VerificationPresentation {
  text: string;
  tone: 'success' | 'warning' | 'error' | 'muted';
}

export function formatVerificationPresentation(
  report: VerificationReport
): VerificationPresentation {
  const commands = formatCommands(report.commands);
  const params = {
    count: report.commands.length,
    commands
  };
  switch (report.status) {
    case 'passed':
      return { text: t('verification.passed', params), tone: 'success' };
    case 'failed':
      return { text: t('verification.failed', params), tone: 'error' };
    case 'not-run':
      return { text: t('verification.notRun', params), tone: 'warning' };
    default:
      return { text: t('verification.notNeeded'), tone: 'muted' };
  }
}

export function verificationToneColor(
  status: VerificationStatus,
  colors: { success: string; warning: string; error: string; muted: string }
): string {
  if (status === 'passed') return colors.success;
  if (status === 'failed') return colors.error;
  if (status === 'not-run') return colors.warning;
  return colors.muted;
}

function formatCommands(commands: string[]): string {
  if (commands.length === 0) return '';
  const visible = commands.slice(0, 3);
  const remaining = commands.length - visible.length;
  return ` · ${visible.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`;
}
