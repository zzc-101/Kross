import { describe, expect, it } from 'vitest';

import { getPublicModel, listPublicModels } from './publicModels';

describe('publicModels', () => {
  it('loads unique, usable repository-managed public models', () => {
    const models = listPublicModels();

    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    expect(models).toHaveLength(1);
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'public-hy3',
          provider: 'anthropic',
          model: 'tencent/Hy3',
          notice: '来源于硅基流动hy3试用，7月21日到期',
          free: true
        })
      ])
    );
    expect(getPublicModel('public-gpt-56')).toBeUndefined();
    expect(getPublicModel('public-grok-45')).toBeUndefined();
    expect(getPublicModel('public-longcat-20')).toBeUndefined();
  });
});
