import type { ContainerOrchestrator } from './containerOrchestrator';
import { WorkspaceRegistry } from './workspaceRegistry';

export class IdleWorkspaceReaper {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly orchestrator: ContainerOrchestrator,
    private readonly idleMs: number,
    private readonly intervalMs = Math.min(idleMs, 60_000),
    private readonly now: () => number = () => Date.now(),
    private readonly isBusy: (workspaceId: string) => Promise<boolean> =
      async () => false,
    private readonly beforeStop: (workspaceId: string) => void =
      () => undefined
  ) {}

  start(): void {
    if (this.timer || this.idleMs <= 0) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(): Promise<string[]> {
    const stopped: string[] = [];
    for (const workspace of this.registry.list()) {
      if (workspace.status !== 'ready' || !workspace.lastActiveAt) continue;
      if (this.now() - Date.parse(workspace.lastActiveAt) < this.idleMs) continue;
      const record = this.registry.get(workspace.id);
      if (!record) continue;
      try {
        if (await this.isBusy(workspace.id)) continue;
      } catch {
        // 无法确认运行状态时保守地保留容器，避免中断未知任务。
        continue;
      }
      this.beforeStop(workspace.id);
      await this.orchestrator.stop(record);
      record.workspace.status = 'stopped';
      record.workspace.updatedAt = new Date(this.now()).toISOString();
      this.registry.put(record);
      stopped.push(workspace.id);
    }
    return stopped;
  }
}
