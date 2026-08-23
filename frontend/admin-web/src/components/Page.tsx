import type { ReactNode } from 'react';
import { Typography } from 'antd';

export function Page({
  title,
  subtitle,
  action,
  children
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Paragraph>{subtitle}</Typography.Paragraph>
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}
