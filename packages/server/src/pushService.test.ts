import {
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined)
  }
}));

import { PushService } from './pushService';

const options = (path: string) => ({
  path,
  subject: 'mailto:test@example.com',
  publicKey: 'public',
  privateKey: 'private'
});
const subscription = {
  endpoint: 'https://push.example.com/subscription',
  keys: { p256dh: 'p256dh', auth: 'auth' }
};

describe('PushService persistence', () => {
  it('writes a versioned document and reads the legacy array format', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-push-'));
    const path = join(root, 'push.json');
    const service = new PushService(options(path));
    service.subscribe(subscription);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 1,
      subscriptions: [subscription]
    });

    writeFileSync(path, JSON.stringify([subscription]));
    expect(() => new PushService(options(path))).not.toThrow();
  });

  it('rejects future subscription versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'kross-push-version-'));
    const path = join(root, 'push.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 2, subscriptions: [] })
    );
    expect(() => new PushService(options(path))).toThrow(
      'Push subscriptions 使用不受支持的数据版本 2'
    );
  });
});
