import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import * as slashSuggestModule from './SlashSuggest';
import { SlashSuggest } from './SlashSuggest';
import type { SlashCommand } from './slashCommands';

const commands = [
  {
    name: '/help',
    description: '查看全部命令',
    category: 'common'
  },
  {
    name: '/model',
    description: '模型与思考强度',
    category: 'common'
  },
  {
    name: '/trace',
    description: '查看运行记录',
    category: 'inspection'
  }
] as SlashCommand[];

describe('SlashSuggest', () => {
  it('renders grouped commands and a compact keyboard footer', () => {
    const { lastFrame } = render(
      <SlashSuggest commands={commands} selectedIndex={0} hiddenCount={2} />
    );

    expect(lastFrame()).toContain('命令');
    expect(lastFrame()).toContain('常用');
    expect(lastFrame()).toContain('运行检查');
    expect(lastFrame()).toContain('还有 2 项，继续输入筛选');
    expect(lastFrame()).toContain('↑↓ 选择');
  });

  it('reports the exact footer height including category rows', () => {
    const resolveHeight = (slashSuggestModule as any).resolveSlashSuggestHeight;
    expect(resolveHeight).toBeTypeOf('function');
    if (typeof resolveHeight !== 'function') {
      return;
    }
    expect(resolveHeight(commands, 2)).toBe(9);
  });

  it('adapts the command label width at 60, 80, and 120 columns', () => {
    const resolveWidth = (slashSuggestModule as any).resolveSlashUsageWidth;
    expect(resolveWidth).toBeTypeOf('function');
    if (typeof resolveWidth !== 'function') {
      return;
    }

    expect([60, 80, 120].map(resolveWidth)).toEqual([22, 30, 30]);
  });
});
