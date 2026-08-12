import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App, ApprovalCard } from './App';

describe('App', () => {
  it('renders the Work Agent bootstrap state without legacy Cloud concepts', () => {
    const html = renderToStaticMarkup(
      <App devUserId="dev-user" onChangeIdentity={() => undefined} />
    );
    expect(html).toContain('正在进入工作空间');
    expect(html).not.toMatch(/Workspace|Session|Git URL|Access Token/);
  });

  it('renders explicit approve and reject actions for pending high-risk approval', () => {
    const html = renderToStaticMarkup(<ApprovalCard approval={{
      id: 'approval-1', organizationId: 'org-1', projectId: 'project-1',
      taskId: 'task-1', runId: 'run-1', kind: 'external_action', scope: 'run',
      riskLevel: 'critical', actionPreview: '向外部系统提交表单', status: 'pending',
      requestedAt: '2026-08-12T00:00:00.000Z'
    }} onDecide={async () => undefined} />);
    expect(html).toContain('严重风险');
    expect(html).toContain('向外部系统提交表单');
    expect(html).toContain('批准');
    expect(html).toContain('拒绝');
    expect(html).not.toContain('能力就绪后开放');
  });

  it('does not render decision actions after the server reports a final status', () => {
    const html = renderToStaticMarkup(<ApprovalCard approval={{
      id: 'approval-1', organizationId: 'org-1', projectId: 'project-1',
      taskId: 'task-1', runId: 'run-1', kind: 'tool', scope: 'run',
      riskLevel: 'high', actionPreview: '执行发布命令', status: 'approved',
      requestedAt: '2026-08-12T00:00:00.000Z', decidedAt: '2026-08-12T00:01:00.000Z',
      decidedBy: 'user-1', decisionIdempotencyKey: 'decision-1'
    }} onDecide={async () => undefined} />);
    expect(html).toContain('已批准');
    expect(html).not.toContain('>拒绝<');
  });
});
