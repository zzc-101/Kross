import type {
  ToolApprovalDecision,
  ToolApprovalPolicy,
  ToolApprovalPolicyContext
} from './toolGateway';

const dangerousShellPatterns: RegExp[] = [
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

/** Fixed Cloud policy: local workspace work proceeds; external effects ask. */
export const saasToolApprovalPolicy: ToolApprovalPolicy = (
  context
): ToolApprovalDecision => {
  const { tool, input } = context;

  if (tool.name === 'Bash') {
    const command = commandFrom(input);
    return command && dangerousShellPatterns.some((pattern) => pattern.test(command))
      ? { action: 'deny', reason: '该命令可能破坏工作区或容器，已自动阻止。' }
      : { action: 'allow', reason: '容器内本地命令' };
  }

  if (tool.name === 'Git') {
    const action = stringField(input, 'action');
    return action === 'push'
      ? { action: 'ask', reason: 'Agent 将向 Git 远端推送提交。' }
      : { action: 'allow', reason: '工作区内 Git 操作' };
  }

  if (tool.risk === 'read' || tool.risk === 'write') {
    return { action: 'allow', reason: '工作区内操作' };
  }

  if (tool.category === 'process' || tool.category === 'verification') {
    return { action: 'allow', reason: '容器内本地进程' };
  }

  if (tool.risk === 'network' || tool.category?.startsWith('mcp:')) {
    return { action: 'ask', reason: 'Agent 将访问或修改外部系统。' };
  }

  return { action: 'ask', reason: '该操作不属于已知的容器内安全操作。' };
};

function commandFrom(input: unknown): string | undefined {
  return stringField(input, 'command') ?? stringField(input, 'cmd');
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
