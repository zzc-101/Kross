import { describe, expect, it } from 'vitest';

import {
  formatUnavailableFreeModels,
  listUnavailableFreeModels
} from './freeModels';

describe('freeModels', () => {
  it('lists models that are visible but not selectable in Kross', () => {
    expect(listUnavailableFreeModels()).toEqual([
      expect.objectContaining({
        id: 'free-gpt-56',
        provider: 'openai',
        models: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
        wireApi: 'responses',
        limitation: 'codex-cli-only'
      })
    ]);
  });

  it('formats stable markdown fields and exposes the shared credential', () => {
    const output = formatUnavailableFreeModels();

    expect(output).toContain('GPT-5.6 Public');
    expect(output).toContain('gpt-5.6-luna');
    expect(output).toContain('gpt-5.6-sol');
    expect(output).toContain('gpt-5.6-terra');
    expect(output).toContain('Codex CLI');
    expect(output).toContain('API Key');
    expect(output).toContain('`https://muyuan.do/v1`');
    expect(output).toContain('`sk-qSELE');
    expect(output).toContain('免责声明');
    expect(output).toContain('仅作公益模型信息分享');
    expect(output).toContain('感谢公益站维护者');
  });
});
