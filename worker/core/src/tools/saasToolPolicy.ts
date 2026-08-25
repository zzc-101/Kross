import type { ToolApprovalDecision, ToolApprovalPolicy } from './toolGateway';

/** Fixed Cloud policy: local workspace work proceeds; external effects ask. */
export const saasToolApprovalPolicy: ToolApprovalPolicy = (
  context
): ToolApprovalDecision => {
  const { tool } = context;

  if (tool.risk === 'read' || tool.risk === 'write') {
    return { action: 'allow', reason: '工作区内操作' };
  }

  if (tool.risk === 'network' || tool.category?.startsWith('mcp:')) {
    return { action: 'ask', reason: 'Agent 将访问或修改外部系统。' };
  }

  return { action: 'ask', reason: '该操作不属于已知的容器内安全操作。' };
};
