import { describe, expect, it } from 'vitest';

import { InMemoryContextManager } from './contextManager';

describe('InMemoryContextManager', () => {
  it('builds LLM messages from system prompt, context sources, tools, and current turn', () => {
    const manager = new InMemoryContextManager();
    manager.addSource({
      id: 'repo-summary',
      kind: 'workspace',
      title: 'Repo Summary',
      content: 'Kross 是本地多仓库 agent。',
      priority: 10
    });

    const snapshot = manager.build({
      systemPrompt: '你是 Kross。',
      currentUserInput: '下一步做什么？',
      mode: 'normal',
      tools: [
        {
          name: 'fs.read',
          description: '读取文件',
          risk: 'read'
        }
      ]
    });

    expect(snapshot.messages[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('你是 Kross。')
    });
    expect(snapshot.messages[0]?.content).toContain('Repo Summary');
    expect(snapshot.messages[0]?.content).toContain('fs.read');
    expect(snapshot.messages.at(-1)).toEqual({
      role: 'user',
      content: '下一步做什么？'
    });
    expect(snapshot.includedSources).toEqual(['repo-summary']);
  });

  it('renders tool categories and input schemas for model planning', () => {
    const manager = new InMemoryContextManager();

    const snapshot = manager.build({
      systemPrompt: '你是 Kross。',
      currentUserInput: '读取 README',
      mode: 'normal',
      tools: [
        {
          name: 'fs.read',
          description: '读取文件',
          risk: 'read',
          category: 'filesystem',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      ]
    });

    expect(snapshot.messages[0]?.content).toContain('category: filesystem');
    expect(snapshot.messages[0]?.content).toContain('"path"');
    expect(snapshot.report.contributors).toContainEqual(
      expect.objectContaining({
        id: 'tool:fs.read',
        section: 'tools'
      })
    );
  });

  it('keeps recent conversation history between turns', () => {
    const manager = new InMemoryContextManager();

    manager.appendConversation({ role: 'user', content: '你好' });
    manager.appendConversation({ role: 'assistant', content: '你好，我是 Kross' });

    const snapshot = manager.build({
      systemPrompt: '你是 Kross。',
      currentUserInput: '你记得我刚才说什么吗？',
      mode: 'normal'
    });

    expect(snapshot.messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，我是 Kross' },
      { role: 'user', content: '你记得我刚才说什么吗？' }
    ]);
  });

  it('drops low-priority context sources when the character budget is tight', () => {
    const manager = new InMemoryContextManager({ maxContextChars: 80 });

    manager.addSource({
      id: 'high',
      kind: 'workspace',
      title: 'High Priority',
      content: '核心上下文',
      priority: 10
    });
    manager.addSource({
      id: 'low',
      kind: 'workspace',
      title: 'Low Priority',
      content: '这是一段很长很长很长很长很长很长的低优先级上下文',
      priority: 1
    });

    const snapshot = manager.build({
      systemPrompt: '系统提示',
      currentUserInput: '用户问题',
      mode: 'normal'
    });

    expect(snapshot.includedSources).toContain('high');
    expect(snapshot.includedSources).not.toContain('low');
    expect(snapshot.droppedSources).toContain('low');
  });

  it('injects skill metadata without loading full skill bodies by default', () => {
    const manager = new InMemoryContextManager();
    manager.registerSkill({
      id: 'security-review',
      name: 'security-review',
      description: '审查安全风险',
      location: 'skills/security-review/SKILL.md',
      body: '这是一段很长的技能正文，只有真正触发技能时才应该加载。'
    });

    const snapshot = manager.build({
      systemPrompt: '你是 Kross。',
      currentUserInput: '帮我看一下风险',
      mode: 'normal'
    });

    expect(snapshot.messages[0]?.content).toContain('security-review');
    expect(snapshot.messages[0]?.content).toContain('审查安全风险');
    expect(snapshot.messages[0]?.content).toContain('skills/security-review/SKILL.md');
    expect(snapshot.messages[0]?.content).not.toContain('这是一段很长的技能正文');
    expect(snapshot.report.contributors).toContainEqual(
      expect.objectContaining({
        id: 'skill:security-review',
        section: 'skills',
        status: 'included'
      })
    );
  });

  it('keeps tool result summaries in context while pruning large raw output', () => {
    const manager = new InMemoryContextManager();

    manager.recordToolResult({
      id: 'tool-1',
      toolName: 'shell.exec',
      inputPreview: 'npm test',
      output: 'PASS '.repeat(1000),
      summary: 'npm test 通过，43 个测试全部成功'
    });

    const snapshot = manager.build({
      systemPrompt: '你是 Kross。',
      currentUserInput: '继续',
      mode: 'normal'
    });

    expect(snapshot.messages[0]?.content).toContain('npm test 通过');
    expect(snapshot.messages[0]?.content).not.toContain('PASS PASS PASS PASS PASS');
    expect(snapshot.report.contributors).toContainEqual(
      expect.objectContaining({
        id: 'tool-result:tool-1',
        section: 'tool-results',
        status: 'pruned'
      })
    );
  });

  it('compacts older history into a reference-only summary and preserves the recent tail', () => {
    const manager = new InMemoryContextManager({ maxHistoryMessages: 20 });
    manager.appendConversation({ role: 'user', content: '第一轮需求' });
    manager.appendConversation({ role: 'assistant', content: '第一轮回答' });
    manager.appendConversation({ role: 'user', content: '第二轮需求' });
    manager.appendConversation({ role: 'assistant', content: '第二轮回答' });

    manager.compactHistory({
      summary: '用户在早前讨论了 Kross 的上下文系统。',
      preserveLastN: 2
    });

    const snapshot = manager.build({
      systemPrompt: '你是 Kross。',
      currentUserInput: '现在继续',
      mode: 'normal'
    });

    expect(snapshot.messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('CONTEXT COMPACTION')
      }),
      { role: 'user', content: '第二轮需求' },
      { role: 'assistant', content: '第二轮回答' },
      { role: 'user', content: '现在继续' }
    ]);
    expect(snapshot.messages[1]?.content).toContain('只作历史参考');
    expect(snapshot.messages[1]?.content).toContain('用户在早前讨论了 Kross 的上下文系统');
  });

  it('reports context contributors and section sizes for inspect commands', () => {
    const manager = new InMemoryContextManager();
    manager.addSource({
      id: 'workspace-rules',
      kind: 'workspace',
      title: 'AGENTS.md',
      content: 'always answer in Chinese',
      priority: 10
    });
    manager.registerSkill({
      id: 'tdd',
      name: 'tdd',
      description: '测试先行',
      location: 'skills/tdd/SKILL.md'
    });

    const snapshot = manager.build({
      systemPrompt: '你是 Kross。',
      currentUserInput: 'inspect',
      mode: 'normal'
    });

    expect(snapshot.report.totalChars).toBeGreaterThan(0);
    expect(snapshot.report.sections.system).toBeGreaterThan(0);
    expect(snapshot.report.sections.sources).toBeGreaterThan(0);
    expect(snapshot.report.sections.skills).toBeGreaterThan(0);
    expect(snapshot.report.contributors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'workspace-rules', section: 'sources' }),
        expect.objectContaining({ id: 'skill:tdd', section: 'skills' })
      ])
    );
  });
});
