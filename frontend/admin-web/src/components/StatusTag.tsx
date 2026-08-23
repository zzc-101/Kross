import { Tag } from 'antd';

export function StatusTag({ active }: { active: boolean }) {
  return <Tag color={active ? 'success' : 'default'}>{active ? '已启用' : '已停用'}</Tag>;
}
