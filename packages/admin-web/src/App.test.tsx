import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('Admin App', () => {
  it('renders a dedicated management bootstrap state', () => {
    const html = renderToStaticMarkup(<App devUserId="dev-user" onChangeIdentity={() => undefined} />);
    expect(html).toContain('正在进入管理中心');
    expect(html).not.toContain('发起 Run');
    expect(html).not.toContain('任务对话');
  });
});
