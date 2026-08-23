import type { ReactNode } from 'react';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';

export function AdminTheme({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#155eef',
          colorInfo: '#155eef',
          colorSuccess: '#17a668',
          colorWarning: '#f79009',
          colorError: '#e5484d',
          colorText: '#182230',
          colorTextSecondary: '#667085',
          colorBgLayout: '#f7f8fa',
          colorBorderSecondary: '#eaecf0',
          borderRadius: 8,
          borderRadiusLG: 12,
          fontSize: 14,
          fontFamily: 'Inter, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
        },
        components: {
          Layout: { bodyBg: '#f7f8fa', headerBg: '#ffffff', siderBg: '#ffffff' },
          Menu: {
            itemBorderRadius: 7,
            itemHeight: 42,
            itemMarginInline: 12,
            itemSelectedBg: '#eaf2ff',
            itemSelectedColor: '#155eef'
          },
          Card: { headerFontSize: 16 },
          Table: { headerBg: '#f9fafb', headerColor: '#667085' },
          Button: { fontWeight: 600 }
        }
      }}
    >
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}
