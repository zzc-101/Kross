import { useMemo, useState } from 'react';
import Bar from '@ant-design/plots/es/components/bar';
import Line from '@ant-design/plots/es/components/line';
import Pie from '@ant-design/plots/es/components/pie';
import {
  ApiOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import { Card, Col, Empty, Row, Select, Space, Table, Typography } from 'antd';
import { AdminApiClient } from '../../apiClient';
import type { PlatformOrganization, TokenUsage, TokenUsageRank } from '../../contracts';
import { MetricGrid } from '../../components/MetricGrid';
import { Page } from '../../components/Page';
import { RefreshButton } from '../../components/RefreshButton';
import { ResourceState } from '../../components/ResourceState';
import { useResource } from '../../hooks/useResource';

const periodOptions = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' }
];

export function TokenUsagePage({ api, platform = false }: { api: AdminApiClient; platform?: boolean }) {
  const [days, setDays] = useState(30);
  const [organizationId, setOrganizationId] = useState<string>();
  const state = useResource(async () => {
    if (!platform) return { usage: await api.organizationTokenUsage(days), organizations: [] };
    const [usage, organizations] = await Promise.all([
      api.tokenUsage(days, organizationId),
      api.organizations()
    ]);
    return { usage, organizations };
  }, [api, days, organizationId, platform]);

  return (
    <Page
      title="Token 统计"
      subtitle={platform ? '查看全平台及各组织的模型调用与 Token 消耗。' : '查看当前组织内的模型调用与 Token 消耗。'}
      action={
        <Space>
          {platform && (
            <OrganizationSelect
              value={organizationId}
              organizations={state.data?.organizations ?? []}
              onChange={setOrganizationId}
            />
          )}
          <Select value={days} options={periodOptions} onChange={setDays} style={{ width: 116 }} />
          <RefreshButton onClick={state.reload} />
        </Space>
      }
    >
      <ResourceState state={state}>
        {({ usage }) => <UsageDashboard usage={usage} platform={platform && !organizationId} />}
      </ResourceState>
    </Page>
  );
}

function UsageDashboard({ usage, platform }: { usage: TokenUsage; platform: boolean }) {
  const average = usage.llmCalls ? Math.round(usage.totalTokens / usage.llmCalls) : 0;
  return (
    <>
      <MetricGrid
        items={[
          {
            title: 'Token 总消耗',
            value: usage.totalTokens,
            icon: <ThunderboltOutlined />,
            tone: 'blue',
            note: `统计周期 ${usage.days} 天`
          },
          {
            title: '输入 Token',
            value: usage.inputTokens,
            icon: <ArrowUpOutlined />,
            tone: 'violet',
            note: `${tokenPercent(usage.inputTokens, usage.totalTokens)}% 总消耗`
          },
          {
            title: '输出 Token',
            value: usage.outputTokens,
            icon: <ArrowDownOutlined />,
            tone: 'green',
            note: `${tokenPercent(usage.outputTokens, usage.totalTokens)}% 总消耗`
          },
          {
            title: '模型调用',
            value: usage.llmCalls,
            icon: <ApiOutlined />,
            tone: 'amber',
            note: `平均 ${average.toLocaleString()} Token/次`
          }
        ]}
      />

      <Row gutter={[20, 20]} className="overview-row">
        <Col span={16}>
          <Card title="Token 消耗趋势">
            <TokenTrend usage={usage} />
          </Card>
        </Col>
        <Col span={8}>
          <Card title="输入 / 输出占比">
            <TokenComposition usage={usage} />
          </Card>
        </Col>
      </Row>

      {platform && (
        <RankingSection title="组织消耗排行" data={usage.organizations} chartColor="#155eef" />
      )}
      <RankingSection title="用户消耗排行" data={usage.users} chartColor="#6941c6" />
      <RankingSection title="模型消耗排行" data={usage.models} chartColor="#079455" />
    </>
  );
}

function TokenTrend({ usage }: { usage: TokenUsage }) {
  const data = useMemo(
    () =>
      usage.trend.flatMap((point) => [
        { date: point.date.slice(5), type: '输入 Token', tokens: point.inputTokens },
        { date: point.date.slice(5), type: '输出 Token', tokens: point.outputTokens }
      ]),
    [usage.trend]
  );
  return usage.totalTokens ? (
    <Line
      data={data}
      xField="date"
      yField="tokens"
      colorField="type"
      height={300}
      axis={{ y: { labelFormatter: compactNumber } }}
      legend={{ color: { position: 'bottom' } }}
      scale={{ color: { range: ['#155eef', '#17a668'] } }}
      style={{ lineWidth: 3 }}
    />
  ) : (
    <ChartEmpty />
  );
}

function TokenComposition({ usage }: { usage: TokenUsage }) {
  const data = [
    { type: '输入 Token', value: usage.inputTokens },
    { type: '输出 Token', value: usage.outputTokens }
  ].filter((item) => item.value > 0);
  return data.length ? (
    <Pie
      data={data}
      angleField="value"
      colorField="type"
      innerRadius={0.65}
      height={300}
      legend={{ color: { position: 'bottom' } }}
      scale={{ color: { range: ['#155eef', '#17a668'] } }}
      annotations={[
        {
          type: 'text',
          style: {
            text: compactNumber(usage.totalTokens),
            x: '50%',
            y: '46%',
            textAlign: 'center',
            fontSize: 22,
            fontWeight: 650
          }
        },
        {
          type: 'text',
          style: { text: 'Token', x: '50%', y: '56%', textAlign: 'center', fill: '#98a2b3' }
        }
      ]}
    />
  ) : (
    <ChartEmpty />
  );
}

function RankingSection({ title, data, chartColor }: { title: string; data: TokenUsageRank[]; chartColor: string }) {
  return (
    <Card title={title} className="section-card">
      {data.length ? (
        <Row gutter={28} align="middle">
          <Col span={13}>
            <Bar
              data={[...data].reverse()}
              xField="totalTokens"
              yField="name"
              height={Math.max(240, data.length * 42)}
              axis={{ x: { labelFormatter: compactNumber } }}
              scale={{ color: { range: [chartColor] } }}
              style={{ radius: 4, fill: chartColor }}
            />
          </Col>
          <Col span={11}>
            <RankingTable data={data} />
          </Col>
        </Row>
      ) : (
        <ChartEmpty />
      )}
    </Card>
  );
}

function RankingTable({ data }: { data: TokenUsageRank[] }) {
  return (
    <Table
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={data}
      columns={[
        {
          title: '排名',
          width: 62,
          render: (_value, _record, index) => <span className={`rank-index rank-${index + 1}`}>{index + 1}</span>
        },
        {
          title: '名称',
          dataIndex: 'name',
          render: (name: string, record: TokenUsageRank) => (
            <div className="usage-rank-name">
              <strong>{name}</strong>
              <span>{record.secondary}</span>
            </div>
          )
        },
        { title: 'Token', dataIndex: 'totalTokens', align: 'right', render: formatNumber },
        { title: '调用', dataIndex: 'llmCalls', align: 'right', render: formatNumber }
      ]}
    />
  );
}

function OrganizationSelect({
  value,
  organizations,
  onChange
}: {
  value?: string;
  organizations: PlatformOrganization[];
  onChange(value?: string): void;
}) {
  return (
    <Select
      value={value}
      allowClear
      placeholder="全部组织"
      onChange={onChange}
      style={{ width: 190 }}
      options={organizations.map((item) => ({ value: item.id, label: item.name }))}
    />
  );
}

function ChartEmpty() {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前周期暂无 Token 数据" className="chart-empty" />;
}

function tokenPercent(value: number, total: number) {
  return total ? ((value / total) * 100).toFixed(1) : '0.0';
}

function compactNumber(value: number) {
  return Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatNumber(value: number) {
  return value.toLocaleString('zh-CN');
}
