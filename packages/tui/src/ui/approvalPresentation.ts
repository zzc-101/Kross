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
        title: '允许读取工作区？',
        riskLabel: '只读访问',
        inputLabel: '输入'
      };
    case 'write':
      return {
        title: '允许修改工作区？',
        riskLabel: '文件写入',
        inputLabel: '输入'
      };
    case 'execute':
      return {
        title: '允许执行命令？',
        riskLabel: '命令执行',
        inputLabel: '命令'
      };
    case 'network':
      return {
        title: '允许访问网络？',
        riskLabel: '网络访问',
        inputLabel: '请求'
      };
    default:
      return {
        title: '允许这次工具调用？',
        riskLabel: risk,
        inputLabel: '输入'
      };
  }
}

export function formatApprovalReason(reason: string): string {
  if (/^(read|write|execute|network) tool requires approval$/i.test(reason)) {
    return '该操作需要你的确认';
  }
  return reason;
}
