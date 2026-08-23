import { useState } from 'react';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { Alert, App, Card, Col, Row, Select, Switch, Typography } from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { ApprovalPolicy } from '../../../contracts';
import { Page } from '../../../components/Page';
import { ResourceState } from '../../../components/ResourceState';
import { SettingRow } from '../../../components/SettingRow';
import { useResource } from '../../../hooks/useResource';

export function PolicyPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.approvalPolicy(), [api]);
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();
  const save = async (policy: ApprovalPolicy) => {
    setSaving(true);
    try {
      const next = await api.updateApprovalPolicy(policy);
      state.setData(next);
      message.success('审批策略已保存');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Page title="审批策略" subtitle="定义 Agent 计划、外部操作和敏感能力的授权边界。">
      <ResourceState state={state}>
        {(policy) => (
          <Row gutter={[20, 20]}>
            <Col xs={24} xl={16}>
              <Card
                title="组织默认策略"
                extra={saving ? <Typography.Text type="secondary">保存中…</Typography.Text> : null}
              >
                <SettingRow title="计划执行前审批" description="Agent 在执行计划之前等待人工确认。">
                  <Switch
                    checked={policy.approvalPolicy.requirePlanApproval}
                    onChange={(checked) =>
                      void save({
                        ...policy,
                        approvalPolicy: { ...policy.approvalPolicy, requirePlanApproval: checked }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow title="外部操作审批" description="发送消息、提交表单或修改第三方系统。">
                  <Switch
                    checked={policy.approvalPolicy.requireExternalActionApproval}
                    onChange={(checked) =>
                      void save({
                        ...policy,
                        approvalPolicy: { ...policy.approvalPolicy, requireExternalActionApproval: checked }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow title="工具审批风险阈值" description="达到该级别的工具调用必须审批。">
                  <Select
                    value={policy.approvalPolicy.minimumToolRiskRequiringApproval}
                    style={{ width: 140 }}
                    onChange={(value) =>
                      void save({
                        ...policy,
                        approvalPolicy: { ...policy.approvalPolicy, minimumToolRiskRequiringApproval: value }
                      })
                    }
                    options={riskOptions}
                  />
                </SettingRow>
              </Card>
            </Col>
            <Col xs={24} xl={8}>
              <Alert
                className="policy-alert"
                type="info"
                showIcon
                icon={<SafetyCertificateOutlined />}
                message="默认拒绝"
                description="无法匹配策略或审批超时的操作将被拒绝。每次决策均记录操作者、时间和资源范围。"
              />
            </Col>
          </Row>
        )}
      </ResourceState>
    </Page>
  );
}
const riskOptions: Array<{
  value: ApprovalPolicy['approvalPolicy']['minimumToolRiskRequiringApproval'];
  label: string;
}> = [
  { value: 'low', label: '低风险' },
  { value: 'medium', label: '中风险' },
  { value: 'high', label: '高风险' },
  { value: 'critical', label: '严重风险' }
];
