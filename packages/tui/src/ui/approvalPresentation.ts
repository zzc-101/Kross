import { t } from '@kross/core';

export type ApprovalSelection = 'approve' | 'reject';

export interface ApprovalPresentation {
  title: string;
  riskLabel: string;
  inputLabel: string;
}

export function defaultApprovalSelection(risk: string): ApprovalSelection {
  return risk === 'execute' || risk === 'network' ? 'reject' : 'approve';
}

export function formatApprovalPresentation(
  risk: string
): ApprovalPresentation {
  switch (risk) {
    case 'read':
      return {
        title: t('approval.read.title'),
        riskLabel: t('approval.read.risk'),
        inputLabel: t('approval.input')
      };
    case 'write':
      return {
        title: t('approval.write.title'),
        riskLabel: t('approval.write.risk'),
        inputLabel: t('approval.input')
      };
    case 'execute':
      return {
        title: t('approval.execute.title'),
        riskLabel: t('approval.execute.risk'),
        inputLabel: t('approval.execute.input')
      };
    case 'network':
      return {
        title: t('approval.network.title'),
        riskLabel: t('approval.network.risk'),
        inputLabel: t('approval.network.input')
      };
    default:
      return {
        title: t('approval.default.title'),
        riskLabel: risk,
        inputLabel: t('approval.input')
      };
  }
}

export function formatApprovalReason(reason: string): string {
  if (/^(read|write|execute|network) tool requires approval$/i.test(reason)) {
    return t('approval.reason');
  }
  return reason;
}
