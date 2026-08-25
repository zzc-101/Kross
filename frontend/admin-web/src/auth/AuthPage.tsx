import { LockOutlined, SafetyCertificateOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';

export function AuthPage({
  mode,
  canRegister,
  ssoEnabled,
  ssoDisplayName,
  error,
  busy,
  onLogin,
  onRegister,
  onToggle
}: {
  mode: 'login' | 'register';
  canRegister: boolean;
  ssoEnabled?: boolean;
  ssoDisplayName?: string;
  error?: string;
  busy: boolean;
  onLogin(username: string, password: string): Promise<void>;
  onRegister(username: string, password: string, displayName: string): Promise<void>;
  onToggle(): void;
}) {
  const register = mode === 'register';
  const ssoLabel = ssoDisplayName || '企业账号';
  const submit = (values: { username: string; password: string; displayName?: string }) =>
    register
      ? onRegister(values.username, values.password, values.displayName || '')
      : onLogin(values.username, values.password);
  return (
    <main className="auth-page">
      <section className="auth-intro">
        <div className="auth-brand">
          <span className="brand-mark">K</span>
          <strong>Kross</strong>
        </div>
        <div>
          <Typography.Title>{register ? '创建管理账号' : '欢迎回到管理中心'}</Typography.Title>
          <Typography.Paragraph>
            {register
              ? '完成平台初始化，开始管理组织与 Agent 工作区。'
              : '统一管理组织、成员、模型服务与安全策略。'}
          </Typography.Paragraph>
        </div>
        <Space direction="vertical" size="large">
          <span>
            <TeamOutlined /> 组织与成员治理
          </span>
          <span>
            <SafetyCertificateOutlined /> 外部操作确认与完整审计
          </span>
        </Space>
      </section>
      <Card className="auth-card" bordered={false}>
        <Typography.Title level={2}>{register ? '首次设置' : '登录'}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {register ? '第一个账号将成为超级管理员。' : '使用你的管理员账号继续。'}
        </Typography.Paragraph>
        {error && <Alert type="error" message={error} showIcon />}
        {!register && ssoEnabled && (
          <Button size="large" type="primary" block href={ssoStartUrl()}>
            使用{ssoLabel}登录
          </Button>
        )}
        {(!ssoEnabled || register) && (
          <Form layout="vertical" size="large" onFinish={(values) => void submit(values)}>
            <Form.Item
              name="username"
              label="用户名"
              rules={[{ required: true, pattern: /^[A-Za-z][A-Za-z0-9_-]{2,31}$/ }]}
            >
              <Input prefix={<UserOutlined />} autoComplete="username" />
            </Form.Item>
            {register && (
              <Form.Item name="displayName" label="昵称（可选）">
                <Input />
              </Form.Item>
            )}
            <Form.Item name="password" label="密码" rules={[{ required: true, min: 8 }]}>
              <Input.Password
                prefix={<LockOutlined />}
                autoComplete={register ? 'new-password' : 'current-password'}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>
              {register ? '注册并进入' : '登录'}
            </Button>
          </Form>
        )}
        {canRegister && (
          <div className="auth-switch">
            {register ? '已有账号？' : '还没有账号？'}
            <Button type="link" onClick={onToggle}>
              {register ? '去登录' : '注册'}
            </Button>
          </div>
        )}
      </Card>
    </main>
  );
}
function ssoStartUrl() {
  const next = import.meta.env.BASE_URL.startsWith('/admin') ? '/admin/' : '/';
  return `/api/v2/auth/sso/start?next=${encodeURIComponent(next)}`;
}
