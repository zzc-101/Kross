import { useState } from 'react';
import { BookOutlined, CloudUploadOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Form, Input, Modal, Space, Table, Tag, Typography, Upload } from 'antd';
import type { UploadFile } from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { KnowledgeDocument } from '../../../contracts';
import { Page } from '../../../components/Page';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { formatDate } from '../../../utils/format';

export function PlatformKnowledgePage({ api }: { api: AdminApiClient }) {
  const documents = useResource(() => api.knowledgeDocuments().then((page) => page.items), [api]);
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File>();
  const [form] = Form.useForm<{ title?: string }>();
  const files: UploadFile[] = file
    ? [{ uid: 'knowledge-file', name: file.name, status: 'done', originFileObj: file as UploadFile['originFileObj'] }]
    : [];

  const ingest = async () => {
    const values = await form.validateFields();
    if (!file) {
      message.error('请选择 Markdown、PDF、Word 或图片文件');
      return;
    }
    await api.ingestKnowledgeDocument({ title: values.title, file });
    message.success('文档已入库，发布后才可被检索');
    setOpen(false);
    form.resetFields();
    setFile(undefined);
    documents.reload();
  };

  const publish = async (row: KnowledgeDocument) => {
    await api.publishKnowledgeDocument(row.id);
    message.success('文档已发布');
    documents.reload();
  };

  return (
    <Page
      title="平台知识库"
      subtitle="上传 Markdown、PDF、Word 或图片到平台空间。未发布的切片不会进入检索。"
      action={
        <Space>
          <RefreshButton onClick={documents.reload} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            上传文档
          </Button>
        </Space>
      }
    >
      <ResourceState state={documents} empty="还没有知识文档。">
        {(items) => (
          <Table
            rowKey="id"
            dataSource={items}
            pagination={{ pageSize: 10 }}
            columns={[
              {
                title: '文档',
                dataIndex: 'title',
                render: (title: string, row: KnowledgeDocument) => (
                  <Space>
                    <BookOutlined />
                    <div>
                      <Typography.Text strong>{title}</Typography.Text>
                      <div>
                        <Typography.Text type="secondary">{row.filename}</Typography.Text>
                      </div>
                    </div>
                  </Space>
                )
              },
              {
                title: '类型',
                dataIndex: 'mime',
                width: 90,
                render: (_: string, row: KnowledgeDocument) => (
                  <Typography.Text type="secondary">{documentKind(row)}</Typography.Text>
                )
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 120,
                render: (status: KnowledgeDocument['status']) => <Tag color={statusColor(status)}>{statusLabel(status)}</Tag>
              },
              { title: '创建时间', dataIndex: 'createdAt', render: formatDate },
              { title: '发布时间', dataIndex: 'publishedAt', render: formatDate },
              {
                title: '操作',
                key: 'actions',
                width: 120,
                render: (_: unknown, row: KnowledgeDocument) =>
                  row.status === 'draft' ? (
                    <Button type="link" onClick={() => void publish(row)}>
                      发布
                    </Button>
                  ) : null
              }
            ]}
          />
        )}
      </ResourceState>
      <Modal
        title="上传文档"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void ingest()}
        okText="入库"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="标题">
            <Input placeholder="留空则使用文件名" />
          </Form.Item>
          <Form.Item label="文件" required>
            <Upload.Dragger
              accept=".md,.markdown,.txt,.pdf,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/gif,image/webp"
              maxCount={1}
              fileList={files}
              beforeUpload={(next) => {
                setFile(fileOf(next));
                return false;
              }}
              onRemove={() => setFile(undefined)}
            >
              <p className="ant-upload-drag-icon">
                <CloudUploadOutlined />
              </p>
              <p>支持 Markdown、PDF、Word（doc/docx），以及 png、jpeg、gif、webp。扫描版 PDF 暂不支持 OCR。</p>
            </Upload.Dragger>
          </Form.Item>
        </Form>
      </Modal>
    </Page>
  );
}

function fileOf(file: UploadFile | File) {
  return 'originFileObj' in file && file.originFileObj ? (file.originFileObj as File) : (file as File);
}

function documentKind(row: KnowledgeDocument) {
  const mime = (row.mime || '').split(';', 1)[0].trim().toLowerCase();
  const name = (row.filename || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(name)) return '图片';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'PDF';
  if (
    mime === 'application/msword' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx?$/.test(name)
  ) {
    return 'Word';
  }
  return '文档';
}

function statusLabel(status: KnowledgeDocument['status']) {
  if (status === 'published') return '已发布';
  if (status === 'processing') return '处理中';
  if (status === 'failed') return '失败';
  return '未发布';
}

function statusColor(status: KnowledgeDocument['status']) {
  if (status === 'published') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'processing') return 'blue';
  return 'default';
}
