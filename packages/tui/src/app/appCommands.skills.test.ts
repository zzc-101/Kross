import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRuntime, type TraceStore } from '@kross/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatSkillsInspection, handleCommand } from './appCommands';

const traceStore: TraceStore = {
  async append() {},
  async readRun() { return []; },
  async listRunIds() { return []; }
};

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function command(value: string, runtime: AgentRuntime) {
  const messages: string[] = [];
  handleCommand(
    value,
    (_from, text) => messages.push(text),
    () => {},
    () => {},
    runtime,
    'auto',
    undefined,
    undefined,
    () => {},
    () => {},
    () => {},
    false,
    async () => {},
    () => {}
  );
  return messages;
}

describe('/skills', () => {
  it('refreshes and shows metadata and diagnostics without bodies', () => {
    root = mkdtempSync(join(tmpdir(), 'kross-skills-command-'));
    const skillDir = join(root, '.agents', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: Review\ndescription: Review safely\n---\nSECRET BODY'
    );
    const runtime = new AgentRuntime({ traceStore, workspaceRoot: root });
    const refresh = vi.spyOn(runtime, 'refreshSkills');

    const messages = command('/skills', runtime);

    expect(refresh).toHaveBeenCalledOnce();
    expect(messages[0]).toContain('Skills');
    expect(messages[0]).toContain('id=review');
    expect(messages[0]).toContain('Review safely');
    expect(messages[0]).not.toContain('SECRET BODY');
  });

  it('formats an empty snapshot', () => {
    expect(
      formatSkillsInspection({ skills: [], diagnostics: [], signature: 'empty' })
    ).toContain('0 skills');
  });
});
