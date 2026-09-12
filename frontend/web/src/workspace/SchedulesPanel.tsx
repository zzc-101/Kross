import { useEffect, useState, type FormEvent } from 'react';
import { CalendarClock, Pause, Play, Plus, Trash2 } from 'lucide-react';

import './Panel.css';
import './MemoryPanel.css';
import './SchedulesPanel.css';

import { AgentApiClient, ApiError } from '../api/client';
import type { AgentSchedule, AgentScheduleRun, Conversation, Skill } from '../api/types';

const STATUS_LABEL: Record<AgentSchedule['status'], string> = {
  active: '进行中',
  paused: '已暂停',
  done: '已完成',
  error: '已停用'
};

const RUN_LABEL: Record<AgentScheduleRun['status'], string> = {
  started: '已投递',
  skipped: '已跳过',
  failed: '失败'
};

const WEEKDAYS = [
  { id: '1', label: '周一' },
  { id: '2', label: '周二' },
  { id: '3', label: '周三' },
  { id: '4', label: '周四' },
  { id: '5', label: '周五' },
  { id: '6', label: '周六' },
  { id: '0', label: '周日' }
];

type Preset = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function cronFromPreset(preset: Preset, time: string, weekday: string, monthDay: string, custom: string): string | undefined {
  if (preset === 'once') return undefined;
  if (preset === 'custom') return custom.trim();
  const [hour, minute] = time.split(':');
  const m = String(Number(minute || '0'));
  const h = String(Number(hour || '9'));
  if (preset === 'daily') return `${m} ${h} * * *`;
  if (preset === 'weekdays') return `${m} ${h} * * 1-5`;
  if (preset === 'weekly') return `${m} ${h} * * ${weekday}`;
  return `${m} ${h} ${Number(monthDay) || 1} * *`;
}

function formatWhen(value?: string | null, timezone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString('zh-CN', timezone ? { timeZone: timezone } : undefined);
  } catch {
    return date.toLocaleString('zh-CN');
  }
}

function toDatetimeLocal(value?: string | null, timezone?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`;
  } catch {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

const emptyForm = () => ({
  name: '',
  prompt: '',
  skillId: '',
  conversationMode: 'new_conversation' as AgentSchedule['conversationMode'],
  conversationId: '',
  timezone: browserZone(),
  preset: 'daily' as Preset,
  time: '09:00',
  weekday: '1',
  monthDay: '1',
  cronExpr: '0 9 * * *',
  runAt: ''
});

function formFromSchedule(item: AgentSchedule) {
  const trigger = inferTrigger(item);
  return {
    name: item.name,
    prompt: item.prompt,
    skillId: item.skillId ?? '',
    conversationMode: item.conversationMode,
    conversationId: item.conversationId ?? '',
    timezone: item.timezone,
    ...trigger
  };
}

function inferTrigger(item: AgentSchedule) {
  if (item.kind === 'once') {
    return {
      preset: 'once' as Preset,
      time: '09:00',
      weekday: '1',
      monthDay: '1',
      cronExpr: '0 9 * * *',
      runAt: toDatetimeLocal(item.runAt ?? item.nextRunAt, item.timezone)
    };
  }
  const cron = item.cronExpr ?? '';
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*') {
    const time = `${String(Number(parts[1])).padStart(2, '0')}:${String(Number(parts[0])).padStart(2, '0')}`;
    if (parts[4] === '*') return { preset: 'daily' as Preset, time, weekday: '1', monthDay: '1', cronExpr: cron, runAt: '' };
    if (parts[4] === '1-5') return { preset: 'weekdays' as Preset, time, weekday: '1', monthDay: '1', cronExpr: cron, runAt: '' };
    if (/^[0-6]$/.test(parts[4])) {
      return { preset: 'weekly' as Preset, time, weekday: parts[4], monthDay: '1', cronExpr: cron, runAt: '' };
    }
  }
  if (parts.length === 5 && parts[3] === '*' && parts[4] === '*' && parts[2] !== '*') {
    return {
      preset: 'monthly' as Preset,
      time: `${String(Number(parts[1])).padStart(2, '0')}:${String(Number(parts[0])).padStart(2, '0')}`,
      weekday: '1',
      monthDay: parts[2],
      cronExpr: cron,
      runAt: ''
    };
  }
  return { preset: 'custom' as Preset, time: '09:00', weekday: '1', monthDay: '1', cronExpr: cron || '0 9 * * *', runAt: '' };
}

export function SchedulesPanel({
  api,
  conversations,
  skills,
  draftPrompt,
  onOpenConversation,
  onConsumedDraft
}: {
  api: AgentApiClient;
  conversations: Conversation[];
  skills: Skill[];
  draftPrompt?: string;
  onOpenConversation(id: string): void;
  onConsumedDraft(): void;
}) {
  const [items, setItems] = useState<AgentSchedule[]>([]);
  const [runs, setRuns] = useState<AgentScheduleRun[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState(emptyForm);

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await api.listSchedules());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法读取自动任务');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [api]);

  useEffect(() => {
    if (!draftPrompt) return;
    setEditingId(undefined);
    setForm((current) => ({
      ...emptyForm(),
      timezone: current.timezone,
      prompt: draftPrompt,
      name: '来自对话'
    }));
    onConsumedDraft();
  }, [draftPrompt, onConsumedDraft]);

  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    void api.listScheduleRuns(selectedId)
      .then((next) => {
        if (!cancelled) setRuns(next);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.prompt.trim()) return;
    setSaving(true);
    setError('');
    try {
      const kind = form.preset === 'once' ? 'once' : 'cron';
      const payload = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        skillId: form.skillId,
        conversationMode: form.conversationMode,
        conversationId: form.conversationMode === 'pinned_conversation' ? form.conversationId : '',
        timezone: form.timezone.trim() || browserZone(),
        kind,
        ...(kind === 'cron'
          ? { cronExpr: cronFromPreset(form.preset, form.time, form.weekday, form.monthDay, form.cronExpr) }
          : { runAt: form.runAt || undefined })
      };
      if (editingId) {
        await api.patchSchedule(editingId, payload);
      } else {
        await api.createSchedule({
          ...payload,
          skillId: payload.skillId || undefined,
          conversationId: payload.conversationId || undefined
        });
        setForm(emptyForm());
      }
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (item: AgentSchedule) => {
    setError('');
    try {
      await api.patchSchedule(item.id, { status: item.status === 'paused' || item.status === 'error' ? 'active' : 'paused' });
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '更新失败');
    }
  };

  const runNow = async (item: AgentSchedule) => {
    setError('');
    try {
      await api.runSchedule(item.id);
      await reload();
      setSelectedId(item.id);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '立即执行失败');
    }
  };

  const remove = async (item: AgentSchedule) => {
    setError('');
    try {
      await api.deleteSchedule(item.id);
      if (selectedId === item.id) setSelectedId(undefined);
      if (editingId === item.id) {
        setEditingId(undefined);
        setForm(emptyForm());
      }
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '删除失败');
    }
  };

  return (
    <div className="workspace-panel schedules-panel">
      <div className="files-toolbar">
        <div>
          <strong>自动任务</strong>
          <small>到点后按这段说明跑一轮 Agent。重复间隔至少 1 小时。</small>
        </div>
      </div>
      {error && <p className="files-error">{error}</p>}
      {loading && <p className="files-hint">正在读取自动任务…</p>}
      <div className="files-list">
        {items.map((item) => (
          <div key={item.id} className={item.id === selectedId ? 'schedule-row selected' : 'schedule-row'}>
            <button
              type="button"
              className="schedule-main"
              onClick={() => {
                setSelectedId(item.id);
                setEditingId(item.id);
                setForm(formFromSchedule(item));
              }}
            >
              <strong>{item.name}</strong>
              <small>{STATUS_LABEL[item.status]} · 下次 {formatWhen(item.nextRunAt, item.timezone)} · 上次 {formatWhen(item.lastRunAt, item.timezone)}</small>
              <p>{item.prompt}</p>
            </button>
            <div className="memory-actions">
              <button type="button" aria-label="立即执行" onClick={() => void runNow(item)}><CalendarClock size={16} /></button>
              <button
                type="button"
                aria-label={item.status === 'active' ? '暂停' : '恢复'}
                onClick={() => void toggle(item)}
                disabled={item.status === 'done'}
              >
                {item.status === 'active' ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button type="button" aria-label="删除" onClick={() => void remove(item)}><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>
      {!loading && items.length === 0 && <p className="files-hint">还没有自动任务。在下面创建，或从对话输入框「设为自动任务」。</p>}
      {selectedId && (
        <div className="schedule-runs">
          <p className="memory-group-title">运行记录</p>
          {runs.length === 0 && <p className="files-hint">还没有运行记录</p>}
          {runs.map((run) => (
            <div key={run.id} className="schedule-run">
              <small>{formatWhen(run.claimedAt, items.find((item) => item.id === selectedId)?.timezone)} · {RUN_LABEL[run.status]}</small>
              {run.error && <p className="files-error">{run.error}</p>}
              {run.conversationId && (
                <button type="button" className="schedule-link" onClick={() => onOpenConversation(run.conversationId!)}>
                  打开对话
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <form className="memory-form" onSubmit={submit}>
        {editingId && (
          <p className="files-hint">
            正在编辑所选任务。
            <button
              type="button"
              className="schedule-link"
              onClick={() => {
                setEditingId(undefined);
                setForm(emptyForm());
              }}
            >
              改为新建
            </button>
          </p>
        )}
        <label>
          <span>名称</span>
          <input
            value={form.name}
            maxLength={80}
            required
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label>
          <span>要做的事</span>
          <textarea
            value={form.prompt}
            maxLength={32768}
            rows={4}
            required
            placeholder="例如：汇总昨天工作区里的进展，写成简报"
            onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
          />
        </label>
        {skills.length > 0 && (
          <label>
            <span>技能（可选）</span>
            <select
              value={form.skillId}
              onChange={(event) => setForm((current) => ({ ...current, skillId: event.target.value }))}
            >
              <option value="">不指定</option>
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>{skill.name}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>运行方式</span>
          <select
            value={form.conversationMode}
            onChange={(event) => setForm((current) => ({
              ...current,
              conversationMode: event.target.value as AgentSchedule['conversationMode']
            }))}
          >
            <option value="new_conversation">每次新开对话</option>
            <option value="pinned_conversation">追加到已有对话</option>
          </select>
        </label>
        {form.conversationMode === 'pinned_conversation' && (
          <label>
            <span>钉住的对话</span>
            <select
              value={form.conversationId}
              required
              onChange={(event) => setForm((current) => ({ ...current, conversationId: event.target.value }))}
            >
              <option value="">选择对话</option>
              {conversations.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>时区</span>
          <input
            value={form.timezone}
            onChange={(event) => setForm((current) => ({ ...current, timezone: event.target.value }))}
          />
        </label>
        <label>
          <span>频率</span>
          <select
            value={form.preset}
            onChange={(event) => setForm((current) => ({ ...current, preset: event.target.value as Preset }))}
          >
            <option value="once">一次性</option>
            <option value="daily">每天</option>
            <option value="weekdays">工作日</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="custom">自定义 cron</option>
          </select>
        </label>
        {form.preset === 'once' ? (
          <label>
            <span>执行时间</span>
            <input
              type="datetime-local"
              required
              value={form.runAt}
              onChange={(event) => setForm((current) => ({ ...current, runAt: event.target.value }))}
            />
          </label>
        ) : form.preset === 'custom' ? (
          <label>
            <span>Cron（5 段，最短每小时）</span>
            <input
              value={form.cronExpr}
              required
              onChange={(event) => setForm((current) => ({ ...current, cronExpr: event.target.value }))}
            />
          </label>
        ) : (
          <>
            <label>
              <span>时刻</span>
              <input
                type="time"
                value={form.time}
                required
                onChange={(event) => setForm((current) => ({ ...current, time: event.target.value }))}
              />
            </label>
            {form.preset === 'weekly' && (
              <label>
                <span>星期</span>
                <select
                  value={form.weekday}
                  onChange={(event) => setForm((current) => ({ ...current, weekday: event.target.value }))}
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day.id} value={day.id}>{day.label}</option>
                  ))}
                </select>
              </label>
            )}
            {form.preset === 'monthly' && (
              <label>
                <span>每月几号</span>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={form.monthDay}
                  onChange={(event) => setForm((current) => ({ ...current, monthDay: event.target.value }))}
                />
              </label>
            )}
          </>
        )}
        <button type="submit" disabled={saving || !form.name.trim() || !form.prompt.trim()}>
          <Plus size={14} />{saving ? '保存中…' : editingId ? '保存修改' : '创建自动任务'}
        </button>
      </form>
    </div>
  );
}
