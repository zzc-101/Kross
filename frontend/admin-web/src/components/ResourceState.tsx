import type { ReactNode } from 'react';
import { Alert, Button, Empty, Skeleton } from 'antd';
import type { ResourceState as State } from '../hooks/useResource';

export function ResourceState<T>({
  state,
  children,
  empty = '暂无数据。'
}: {
  state: State<T>;
  children: (data: T) => ReactNode;
  empty?: string;
}) {
  if (state.loading)
    return (
      <div className="resource-state">
        <Skeleton active paragraph={{ rows: 4 }} />
      </div>
    );
  if (state.error)
    return (
      <Alert
        type="error"
        showIcon
        message="加载失败"
        description={state.error}
        action={<Button onClick={state.reload}>重试</Button>}
      />
    );
  if (Array.isArray(state.data) && state.data.length === 0) return <Empty description={empty} />;
  return state.data === undefined ? null : <>{children(state.data)}</>;
}
