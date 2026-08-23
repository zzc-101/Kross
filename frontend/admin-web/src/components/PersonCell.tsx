import { UserOutlined } from '@ant-design/icons';
import { Avatar, Space } from 'antd';

export function PersonCell({ name, username, avatar }: { name: string; username: string; avatar?: string }) {
  return (
    <Space>
      <Avatar src={avatar} icon={<UserOutlined />} />
      <div className="person-cell">
        <strong>{name}</strong>
        <span>{username}</span>
      </div>
    </Space>
  );
}
