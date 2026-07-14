import type {
  ToolApprovalDecision,
  ToolApprovalPolicy,
  ToolApprovalPolicyContext
} from './toolGateway';

export const permissionModes = ['default', 'classifier', 'auto'] as const;
export type PermissionMode = (typeof permissionModes)[number];

export const permissionModeLabels: Record<PermissionMode, string> = {
  default: 'default',
  classifier: 'classifier',
  auto: 'auto'
};

/** 输入框页脚等 UI 用的简短标签。 */
export const permissionModeFooterLabels: Record<PermissionMode, string> = {
  default: 'default',
  classifier: 'classifier',
  auto: 'always-approve'
};

export function formatPermissionFooter(mode: PermissionMode): string {
  return permissionModeFooterLabels[mode] ?? mode;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (permissionModes as readonly string[]).includes(value);
}

export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const index = permissionModes.indexOf(current);
  return permissionModes[(index + 1) % permissionModes.length] ?? 'default';
}

/**
 * 按权限模式生成 ToolGateway 审批策略。
 * - default: read 放行，其余 ask
 * - classifier: 规则分类器自动 allow/ask/deny
 * - auto: 全部放行
 */
export function createApprovalPolicy(mode: PermissionMode): ToolApprovalPolicy {
  switch (mode) {
    case 'auto':
      return () => ({ action: 'allow' });
    case 'classifier':
      return classifyToolCall;
    case 'default':
    default:
      return defaultManualPolicy;
  }
}

function defaultManualPolicy(context: ToolApprovalPolicyContext): ToolApprovalDecision {
  return context.tool.risk === 'read'
    ? { action: 'allow' }
    : { action: 'ask', reason: `${context.tool.risk} tool requires approval` };
}

const readLikeTools = new Set([
  'Read',
  'Glob',
  'Grep',
  'List',
  'Stat',
  'GitStatus',
  'GitDiff',
  'GitLog',
  'Task',
  'fs.read'
]);
const writeLikeTools = new Set([
  'Write',
  'Edit',
  'Delete',
  'Move',
  'fs.write',
  'fs.edit',
  'fs.delete',
  'fs.move'
]);

const dangerousBashPatterns: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\b/,
  /\brm\s+(-[a-zA-Z]*rf|-rf|-fr)\b.*(\/|~|\$HOME)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/i,
  /\bgit\s+push\b.*--force\b/i,
  /\bchmod\s+-R\s+777\s+\/\b/i,
  /\b>\s*\/dev\/sd[a-z]\b/i
];

function classifyToolCall(context: ToolApprovalPolicyContext): ToolApprovalDecision {
  const { tool, input } = context;
  const name = tool.name;

  if (tool.risk === 'read' || readLikeTools.has(name)) {
    return { action: 'allow', reason: 'classifier: read-like tool' };
  }

  if (writeLikeTools.has(name) || tool.risk === 'write') {
    return { action: 'allow', reason: 'classifier: workspace-scoped write' };
  }

  if (name === 'Bash' || tool.risk === 'execute') {
    const command = extractCommand(input);
    if (command && isDangerousBash(command)) {
      return {
        action: 'deny',
        reason: 'classifier: blocked dangerous shell command'
      };
    }
    return {
      action: 'ask',
      reason: 'classifier: shell command needs confirmation'
    };
  }

  if (tool.risk === 'network') {
    return {
      action: 'ask',
      reason: 'classifier: network tool needs confirmation'
    };
  }

  return {
    action: 'ask',
    reason: 'classifier: unfamiliar tool needs confirmation'
  };
}

function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.command === 'string') {
    return record.command;
  }
  if (typeof record.cmd === 'string') {
    return record.cmd;
  }
  return undefined;
}

function isDangerousBash(command: string): boolean {
  return dangerousBashPatterns.some((pattern) => pattern.test(command));
}
