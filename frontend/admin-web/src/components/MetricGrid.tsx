import type { ReactNode } from 'react';
import { Card, Col, Flex, Row, Statistic, Typography } from 'antd';

export type MetricItem = {
  title: string;
  value: number;
  icon: ReactNode;
  tone: 'blue' | 'green' | 'violet' | 'amber';
  note: string;
};

export function MetricGrid({ items }: { items: MetricItem[] }) {
  return (
    <Row gutter={[16, 16]}>
      {items.map((item) => (
        <Col xs={24} sm={12} xl={6} key={item.title}>
          <Card className="metric-card">
            <Flex align="center" gap={16}>
              <span className={`metric-icon ${item.tone}`}>{item.icon}</span>
              <div>
                <Statistic title={item.title} value={item.value} />
                <Typography.Text type="secondary">{item.note}</Typography.Text>
              </div>
            </Flex>
          </Card>
        </Col>
      ))}
    </Row>
  );
}
