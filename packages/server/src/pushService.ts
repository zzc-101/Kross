import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';

import type { ClientCommand } from '@kross/protocol';
import webpush from 'web-push';

type Subscription = Extract<
  ClientCommand,
  { type: 'push.subscribe' }
>['subscription'];

export interface PushServiceOptions {
  path: string;
  subject: string;
  publicKey: string;
  privateKey: string;
}

export class PushService {
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(private readonly options: PushServiceOptions) {
    webpush.setVapidDetails(
      options.subject,
      options.publicKey,
      options.privateKey
    );
    this.load();
  }

  get publicKey(): string {
    return this.options.publicKey;
  }

  subscribe(subscription: Subscription): void {
    this.subscriptions.set(subscription.endpoint, structuredClone(subscription));
    this.persist();
  }

  async notifyApproval(input: {
    workspaceId: string;
    sessionId?: string;
    runId: string;
    toolName: string;
    risk: string;
  }): Promise<void> {
    const payload = JSON.stringify({
      title: `${input.toolName} 等待审批`,
      body: `风险级别：${input.risk}`,
      url: `/?workspace=${encodeURIComponent(input.workspaceId)}&session=${encodeURIComponent(input.sessionId ?? '')}&runId=${encodeURIComponent(input.runId)}`
    });
    for (const [endpoint, subscription] of this.subscriptions) {
      try {
        await webpush.sendNotification(subscription, payload, { TTL: 300 });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          this.subscriptions.delete(endpoint);
        }
      }
    }
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.options.path)) return;
    const values = JSON.parse(readFileSync(this.options.path, 'utf8')) as Subscription[];
    for (const value of values) this.subscriptions.set(value.endpoint, value);
  }

  private persist(): void {
    mkdirSync(dirname(this.options.path), { recursive: true });
    const temporary = `${this.options.path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify([...this.subscriptions.values()], null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    renameSync(temporary, this.options.path);
  }
}
