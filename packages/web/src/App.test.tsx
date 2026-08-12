import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './App';

describe('App', () => {
  it('renders the Work Agent bootstrap state without legacy Cloud concepts', () => {
    const html = renderToStaticMarkup(
      <App devUserId="dev-user" onChangeIdentity={() => undefined} />
    );
    expect(html).toContain('正在进入工作空间');
    expect(html).not.toMatch(/Workspace|Session|Git URL|Access Token/);
  });
});
