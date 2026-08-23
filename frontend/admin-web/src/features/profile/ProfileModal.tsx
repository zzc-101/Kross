import { useState } from 'react';
import { Form, Input, Modal, Select, message } from 'antd';
import { AdminApiClient } from '../../apiClient';
import type { Session } from '../../contracts';

export function ProfileModal({
  open,
  api,
  session,
  onClose,
  onSaved
}: {
  open: boolean;
  api: AdminApiClient;
  session: Session;
  onClose(): void;
  onSaved(next: Session): void;
}) {
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const submit = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const next = await api.updateProfile(values);
      message.success('个人资料已更新');
      onSaved(next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="个人资料"
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={busy}
      okText="保存"
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          displayName: session.user.displayName,
          avatarUrl: session.user.avatarUrl,
          gender: session.user.gender ?? 'unspecified',
          phone: session.user.phone
        }}
      >
        <Form.Item name="displayName" label="昵称" rules={[{ required: true }]}>
          <Input maxLength={64} />
        </Form.Item>
        <Form.Item name="avatarUrl" label="头像 URL">
          <Input placeholder="https://" />
        </Form.Item>
        <Form.Item name="gender" label="性别">
          <Select
            options={[
              { value: 'unspecified', label: '未说明' },
              { value: 'male', label: '男' },
              { value: 'female', label: '女' },
              { value: 'other', label: '其他' }
            ]}
          />
        </Form.Item>
        <Form.Item name="phone" label="手机号">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
