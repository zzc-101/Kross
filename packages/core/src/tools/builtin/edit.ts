import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import {
  buildOverwriteDiffPreview,
  buildReplaceDiffPreview,
  type DiffPreview
} from '../diffPreview';
import {
  formatLineDelta,
  hunkLineStats
} from './fileChangeStats';
import { resolveExistingPathWithinWorkspace } from './paths';
import type { MutationService } from '../../mutations/mutationService';

const singleEditSchema = z.object({
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional()
});

const editInputSchema = z
  .object({
    path: z.string().min(1),
    old_string: z.string().min(1).optional(),
    new_string: z.string().optional(),
    replace_all: z.boolean().optional(),
    /** 同一文件多处替换；与 old_string/new_string 二选一或并用（edits 优先） */
    edits: z.array(singleEditSchema).min(1).max(50).optional()
  })
  .superRefine((value, ctx) => {
    const hasEdits = Array.isArray(value.edits) && value.edits.length > 0;
    const hasSingle =
      typeof value.old_string === 'string' && typeof value.new_string === 'string';
    if (!hasEdits && !hasSingle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '需要提供 old_string+new_string，或 edits[]'
      });
    }
  });

type EditInput = z.infer<typeof editInputSchema>;

interface NormalizedEdit {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

export interface EditResultData {
  path: string;
  occurrences: number;
  linesAdded: number;
  linesRemoved: number;
  replaceAll: boolean;
  mutated: boolean;
  editCount?: number;
  /** TUI 展开用红绿 diff 预览 */
  diffPreview?: DiffPreview;
  /** 失败时的定位提示 */
  hint?: string;
}

export function createEditTool(
  workspaceRoot: string,
  mutations?: MutationService
): ToolDefinition<EditInput> {
  return {
    name: 'Edit',
    description:
      '在文件内做精确字符串替换。默认 old_string 须唯一；可 replace_all。支持 edits[] 一次改多处（按顺序应用）。失败时返回附近内容提示。',
    risk: 'write',
    category: 'filesystem',
    inputSchema: editInputSchema,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对路径' },
        old_string: { type: 'string', description: '要被替换的文本（单处模式）' },
        new_string: { type: 'string', description: '替换后的文本（单处模式）' },
        replace_all: {
          type: 'boolean',
          description: '单处模式下是否替换全部匹配'
        },
        edits: {
          type: 'array',
          description: '多处替换列表，按顺序应用到同一文件',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' }
            },
            required: ['old_string', 'new_string']
          }
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async ({ input, runId }) => {
      const filePath = await resolveExistingPathWithinWorkspace(
        workspaceRoot,
        input.path
      );
      const original = await readFile(filePath, 'utf8');
      const displayPath = input.path;
      const edits = normalizeEdits(input);

      let content = original;
      let totalOccurrences = 0;
      let totalAdded = 0;
      let totalRemoved = 0;
      let anyReplaceAll = false;
      const applied: Array<{
        old_string: string;
        new_string: string;
        count: number;
      }> = [];

      for (let i = 0; i < edits.length; i += 1) {
        const edit = edits[i]!;
        const count = content.split(edit.old_string).length - 1;

        if (count === 0) {
          // 尝试宽松空白匹配（仅当精确失败）
          const relaxed = tryRelaxedReplace(content, edit);
          if (!relaxed) {
            const hint = buildNoMatchHint(content, edit.old_string);
            return {
              content: [
                `未找到 old_string（第 ${i + 1}/${edits.length} 处编辑），未做修改：${displayPath}`,
                hint
              ].join('\n'),
              summary: 'no match',
              data: {
                path: displayPath,
                occurrences: 0,
                linesAdded: 0,
                linesRemoved: 0,
                replaceAll: edit.replace_all,
                mutated: false,
                editCount: edits.length,
                hint
              } satisfies EditResultData
            };
          }
          content = relaxed.content;
          totalOccurrences += relaxed.count;
          const stats = hunkLineStats(
            edit.old_string,
            edit.new_string,
            relaxed.count
          );
          totalAdded += stats.linesAdded;
          totalRemoved += stats.linesRemoved;
          anyReplaceAll = anyReplaceAll || edit.replace_all;
          applied.push({
            old_string: edit.old_string,
            new_string: edit.new_string,
            count: relaxed.count
          });
          continue;
        }

        if (count > 1 && !edit.replace_all) {
          const hint = buildAmbiguousHint(content, edit.old_string, count);
          return {
            content: [
              `old_string 出现 ${count} 次（第 ${i + 1}/${edits.length} 处编辑），存在歧义未做修改。`,
              `请提供更多上下文，或设置 replace_all: true。`,
              hint
            ].join('\n'),
            summary: `ambiguous: ${count} matches`,
            data: {
              path: displayPath,
              occurrences: count,
              linesAdded: 0,
              linesRemoved: 0,
              replaceAll: false,
              mutated: false,
              editCount: edits.length,
              hint
            } satisfies EditResultData
          };
        }

        content = edit.replace_all
          ? content.split(edit.old_string).join(edit.new_string)
          : content.replace(edit.old_string, edit.new_string);

        totalOccurrences += count;
        const stats = hunkLineStats(edit.old_string, edit.new_string, count);
        totalAdded += stats.linesAdded;
        totalRemoved += stats.linesRemoved;
        anyReplaceAll = anyReplaceAll || edit.replace_all;
        applied.push({
          old_string: edit.old_string,
          new_string: edit.new_string,
          count
        });
      }

      if (content === original) {
        return {
          content: `内容未变化：${displayPath}`,
          summary: 'no change',
          data: {
            path: displayPath,
            occurrences: totalOccurrences,
            linesAdded: 0,
            linesRemoved: 0,
            replaceAll: anyReplaceAll,
            mutated: false,
            editCount: edits.length
          } satisfies EditResultData
        };
      }

      const write = async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content, 'utf8');
      };
      if (mutations) {
        await mutations.record({
          runId,
          toolName: 'Edit',
          paths: [input.path],
          action: write
        });
      } else {
        await write();
      }

      const delta = formatLineDelta({
        linesAdded: totalAdded,
        linesRemoved: totalRemoved
      });

      // 单处：替换块 + 文件上下文；多处：全文 before/after LCS（含全部变更）
      const diffPreview: DiffPreview =
        applied.length === 1
          ? buildReplaceDiffPreview(
              applied[0]!.old_string,
              applied[0]!.new_string,
              { fileContent: original, contextLines: 3 }
            )
          : buildOverwriteDiffPreview(original, content, {
              contextLines: 3,
              maxLines: 80
            });

      const multi =
        edits.length > 1 ? ` · ${edits.length} edits` : '';

      return {
        content: `已替换 ${totalOccurrences} 处：${displayPath} (${delta})${multi}`,
        summary: `replaced ${totalOccurrences} · ${delta}${multi}`,
        data: {
          path: displayPath,
          occurrences: totalOccurrences,
          linesAdded: totalAdded,
          linesRemoved: totalRemoved,
          replaceAll: anyReplaceAll,
          mutated: true,
          editCount: edits.length,
          diffPreview
        } satisfies EditResultData
      };
    }
  };
}

function normalizeEdits(input: EditInput): NormalizedEdit[] {
  if (input.edits && input.edits.length > 0) {
    return input.edits.map((edit) => ({
      old_string: edit.old_string,
      new_string: edit.new_string,
      replace_all: edit.replace_all === true
    }));
  }
  return [
    {
      old_string: input.old_string ?? '',
      new_string: input.new_string ?? '',
      replace_all: input.replace_all === true
    }
  ];
}

/**
 * 宽松空白匹配：把连续空白压成 \\s+ 再试一次。
 * 仅当精确匹配失败时使用，避免误伤有意空格。
 */
function tryRelaxedReplace(
  content: string,
  edit: NormalizedEdit
): { content: string; count: number } | null {
  const pattern = escapeRegExp(edit.old_string).replace(/\s+/g, '\\s+');
  if (pattern === escapeRegExp(edit.old_string)) {
    return null;
  }
  const re = new RegExp(pattern, edit.replace_all ? 'g' : '');
  const matches = content.match(new RegExp(pattern, 'g'));
  const count = matches?.length ?? 0;
  if (count === 0) {
    return null;
  }
  if (count > 1 && !edit.replace_all) {
    return null;
  }
  const next = content.replace(re, edit.new_string);
  if (next === content) {
    return null;
  }
  return { content: next, count: edit.replace_all ? count : 1 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNoMatchHint(content: string, oldString: string): string {
  const needle = oldString.trim().slice(0, 40);
  const lines = content.split('\n');
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (needle.length > 0 && line.includes(needle.slice(0, 12))) {
      bestIdx = i;
      bestScore = 2;
      break;
    }
    // 简单字符重叠
    const score = overlapScore(line, needle);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < 2) {
    const head = lines.slice(0, 5).map((l, i) => `  ${i + 1}| ${clip(l, 100)}`);
    return ['文件开头：', ...head].join('\n');
  }

  const from = Math.max(0, bestIdx - 2);
  const to = Math.min(lines.length, bestIdx + 3);
  const snippet = [];
  for (let i = from; i < to; i += 1) {
    const mark = i === bestIdx ? '>' : ' ';
    snippet.push(`${mark} ${i + 1}| ${clip(lines[i] ?? '', 100)}`);
  }
  return ['附近内容（供调整 old_string）：', ...snippet].join('\n');
}

function buildAmbiguousHint(
  content: string,
  oldString: string,
  count: number
): string {
  const lines = content.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < 5; i += 1) {
    if ((lines[i] ?? '').includes(oldString.split('\n')[0] ?? oldString)) {
      hits.push(i + 1);
    }
  }
  const where =
    hits.length > 0 ? `约在行：${hits.join(', ')}${count > hits.length ? '…' : ''}` : '';
  return where;
}

function overlapScore(line: string, needle: string): number {
  if (!needle || !line) {
    return 0;
  }
  let score = 0;
  const parts = needle.split(/\s+/).filter((p) => p.length >= 3);
  for (const p of parts) {
    if (line.includes(p)) {
      score += 1;
    }
  }
  return score;
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}
