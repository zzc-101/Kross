import { ReloadOutlined } from '@ant-design/icons';
import { Button } from 'antd';

export function RefreshButton({ onClick }: { onClick(): void }) {
  return (
    <Button icon={<ReloadOutlined />} onClick={onClick}>
      刷新
    </Button>
  );
}
