import { ApartmentOutlined } from '@ant-design/icons';
import { Avatar, Button, Space, Table } from 'antd';
import type { PlatformOrganization } from '../../../../contracts';
import { StatusTag } from '../../../../components/StatusTag';
import { formatDate } from '../../../../utils/format';

export function OrganizationsTable({
  data,
  compact,
  onAdmin,
  onStatus
}: {
  data: PlatformOrganization[];
  compact?: boolean;
  onAdmin?(record: PlatformOrganization): void;
  onStatus?(record: PlatformOrganization): void;
}) {
  return (
    <Table
      rowKey="id"
      dataSource={data}
      size={compact ? 'middle' : 'large'}
      pagination={compact ? false : { pageSize: 10 }}
      scroll={{ x: 620 }}
      columns={[
        {
          title: '组织',
          dataIndex: 'name',
          render: (name: string, record) => (
            <div className="organization-cell">
              <Avatar shape="square" icon={<ApartmentOutlined />} />
              <div>
                <strong>{name}</strong>
                <span>{record.slug}</span>
              </div>
            </div>
          )
        },
        { title: '成员', dataIndex: 'memberCount', width: 110 },
        { title: '管理员', dataIndex: 'adminCount', width: 110 },
        {
          title: '状态',
          dataIndex: 'status',
          width: 120,
          render: (status) => <StatusTag active={status === 'active'} />
        },
        { title: '创建时间', dataIndex: 'createdAt', width: 190, responsive: ['lg'], render: formatDate },
        ...(onAdmin || onStatus
          ? [
              {
                title: '操作',
                key: 'actions',
                width: 190,
                render: (_: unknown, record: PlatformOrganization) => (
                  <Space>
                    <Button type="link" onClick={() => onAdmin?.(record)}>
                      分配管理员
                    </Button>
                    <Button
                      type="link"
                      danger={record.status === 'active'}
                      onClick={() => onStatus?.(record)}
                    >
                      {record.status === 'active' ? '停用' : '启用'}
                    </Button>
                  </Space>
                )
              }
            ]
          : [])
      ]}
    />
  );
}
