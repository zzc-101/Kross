import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildWindowsTaskkillArgs, ProcessManager } from './processManager';

let root = '';
let manager: ProcessManager | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kross-process-'));
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('ProcessManager', () => {
  it('runs a real process and reports stdout, stderr and non-zero exit', async () => {
    manager = new ProcessManager(root, { createProcessId: () => 'process-real' });
    const started = await manager.start({
      command: nodeCommand("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)")
    });
    expect(started).toMatchObject({ processId: 'process-real', status: 'running' });

    const result = await pollUntilDone(manager, started.processId);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(3);
  });

  it('writes stdin, sends EOF and reads output incrementally by cursor', async () => {
    manager = new ProcessManager(root);
    const started = await manager.start({
      command: nodeCommand(
        "let value=''; process.stdin.on('data', c => value += c); process.stdin.on('end', () => process.stdout.write(value.toUpperCase()))"
      )
    });
    await manager.write(started.processId, 'hello ');
    await manager.write(started.processId, 'agent', true);
    const first = await pollUntilDone(manager, started.processId);
    expect(first.stdout).toBe('HELLO AGENT');
    const second = manager.poll(started.processId, first.cursor);
    expect(second.stdout).toBe('');
    expect(second.stderr).toBe('');
  });

  it('bounds ring buffers and per-poll output while exposing truncation', async () => {
    manager = new ProcessManager(root, { maxBufferBytes: 10, maxPollBytes: 5 });
    const started = await manager.start({
      command: nodeCommand("process.stdout.write('0123456789ABCDEFGHIJ')")
    });
    await waitForStatus(manager, started.processId, 'exited');
    const first = manager.poll(started.processId, {}, 5);
    expect(first.stdout).toBe('ABCDE');
    expect(first.truncated.stdout).toBe(true);
    const second = manager.poll(started.processId, first.cursor, 5);
    expect(second.stdout).toBe('FGHIJ');
    expect(Buffer.byteLength(first.stdout)).toBeLessThanOrEqual(5);
  });

  it('terminates process groups and close cleans all active handles', async () => {
    manager = new ProcessManager(root, { termGraceMs: 100 });
    const first = await manager.start({
      command: nodeCommand(
        "process.stdout.write(String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
      )
    });
    const descendantPid = await readDescendantPid(manager, first.processId);
    const killed = await manager.kill(first.processId);
    expect(killed.status).toBe('killed');
    if (process.platform !== 'win32') {
      expect(killed.signal).toBeTruthy();
    }
    await expectProcessGone(descendantPid);

    const second = await manager.start({ command: nodeCommand('setInterval(() => {}, 1000)') });
    await manager.close();
    expect(manager.poll(second.processId).status).toBe('killed');
  });

  it('does not kill an established managed process when the start signal aborts later', async () => {
    manager = new ProcessManager(root);
    const controller = new AbortController();
    const started = await manager.start({
      command: nodeCommand('setInterval(() => {}, 1000)'),
      signal: controller.signal
    });
    controller.abort(new Error('foreground turn interrupted'));
    await delay(20);
    expect(manager.poll(started.processId).status).toBe('running');
    await manager.kill(started.processId);
  });

  it('backs off repeated async polls when a running process makes no progress', async () => {
    let clock = 0;
    const waits: number[] = [];
    manager = new ProcessManager(root, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      }
    });
    const started = await manager.start({
      command: nodeCommand('setInterval(() => {}, 1000)')
    });
    const first = manager.poll(started.processId);
    const unchanged = manager.poll(started.processId, first.cursor);
    expect(unchanged.progress).toEqual({
      state: 'unchanged',
      unchangedPolls: 1,
      recommendedDelayMs: 250
    });

    const backedOff = await manager.pollWithProgress(
      started.processId,
      unchanged.cursor
    );
    expect(waits).toEqual([250]);
    expect(backedOff.progress).toMatchObject({
      state: 'unchanged',
      unchangedPolls: 2,
      recommendedDelayMs: 500
    });
  });

  it('rejects workspace escapes and unknown process ids', async () => {
    manager = new ProcessManager(root);
    const outside = await mkdtemp(join(tmpdir(), 'kross-process-outside-'));
    try {
      await expect(
        manager.start({ command: nodeCommand("process.stdout.write('no')"), cwd: outside })
      ).rejects.toThrow(/workspace/);
      expect(() => manager!.poll('process-missing')).toThrow(/Unknown managed process/);
      await expect(manager.write('process-missing', 'x')).rejects.toThrow(
        /Unknown managed process/
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('allows a real workspace subdirectory cwd', async () => {
    const childDir = join(root, 'child');
    await mkdir(childDir);
    manager = new ProcessManager(root);
    const started = await manager.start({
      command: nodeCommand('process.stdout.write(process.cwd())'),
      cwd: 'child'
    });
    const result = await pollUntilDone(manager, started.processId);
    // Windows shells may expose the cwd through its equivalent 8.3 short path.
    expect(await realpath(result.stdout)).toBe(await realpath(childDir));
  });

  it('isolates handles by persistent session while close still owns all scopes', async () => {
    let sequence = 0;
    manager = new ProcessManager(root, {
      createProcessId: () => `process-session-${sequence++}`
    });
    manager.setSessionScope('session-a');
    const first = await manager.start({
      command: nodeCommand('setInterval(() => {}, 1000)')
    });

    manager.setSessionScope('session-b');
    expect(manager.list()).toEqual([]);
    expect(() => manager!.poll(first.processId)).toThrow(/Unknown managed process/);
    await expect(manager.write(first.processId, 'x')).rejects.toThrow(
      /Unknown managed process/
    );
    await expect(manager.kill(first.processId)).rejects.toThrow(
      /Unknown managed process/
    );

    const second = await manager.start({
      command: nodeCommand('setInterval(() => {}, 1000)')
    });
    expect(manager.list().map((item) => item.processId)).toEqual([second.processId]);

    manager.setSessionScope('session-a');
    expect(manager.list().map((item) => item.processId)).toEqual([first.processId]);
    await manager.close();
    expect(manager.poll(first.processId).status).toBe('killed');
  });

  it('uses taskkill tree and force flags for Windows descendants', async () => {
    expect(buildWindowsTaskkillArgs(1234)).toEqual([
      '/PID',
      '1234',
      '/T',
      '/F'
    ]);
    const killedPids: number[] = [];
    manager = new ProcessManager(root, {
      platform: 'win32',
      termGraceMs: 20,
      killWindowsProcessTree: async (pid) => {
        killedPids.push(pid);
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The short-lived shell may already be gone.
        }
      }
    });
    const started = await manager.start({
      command: nodeCommand('setTimeout(() => {}, 50)')
    });
    const killed = await manager.kill(started.processId);
    expect(killedPids).toHaveLength(1);
    expect(killedPids[0]).toBeGreaterThan(0);
    expect(killed.status).toBe('killed');
    expect(killed.completedAt).toBeTruthy();
  });

  it('falls back when Windows tree cleanup is unavailable', async () => {
    manager = new ProcessManager(root, {
      platform: 'win32',
      termGraceMs: 20,
      killWindowsProcessTree: async () => {
        throw new Error('taskkill unavailable');
      }
    });
    const started = await manager.start({
      command: nodeCommand('setTimeout(() => {}, 50)')
    });
    const killed = await manager.kill(started.processId);
    expect(killed.status).toBe('killed');
    expect(killed.completedAt).toBeTruthy();
  });
});

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

async function pollUntilDone(manager: ProcessManager, processId: string) {
  let cursor = { stdout: 0, stderr: 0 };
  let stdout = '';
  let stderr = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = manager.poll(processId, cursor);
    cursor = result.cursor;
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.status !== 'running') return { ...result, stdout, stderr };
    await delay(10);
  }
  throw new Error(`Process did not finish: ${processId}`);
}

async function waitForStatus(
  manager: ProcessManager,
  processId: string,
  status: 'exited' | 'killed'
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.poll(processId).status === status) return;
    await delay(10);
  }
  throw new Error(`Process did not reach ${status}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readDescendantPid(
  manager: ProcessManager,
  processId: string
): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = manager.poll(processId).stdout.trim();
    if (output) return Number(output);
    await delay(10);
  }
  throw new Error('Child PID was not reported');
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Descendant process still exists: ${pid}`);
}
