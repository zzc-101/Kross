export const TODO_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled'
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoWriteInput {
  todos: TodoItem[];
  /**
   * When true (default): upsert by id, keep unspecified items.
   * When false: replace the entire list with `todos`.
   */
  merge?: boolean;
}

export interface TodoStoreSnapshot {
  todos: TodoItem[];
  counts: Record<TodoStatus, number>;
}

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  cancelled: '[-]'
};

/**
 * Session-scoped todo list for the agent (Claude Code–style TodoWrite).
 * In-memory only; not persisted across process restarts.
 */
export class TodoStore {
  private items: TodoItem[] = [];
  private readonly listeners = new Set<() => void>();

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  snapshot(): TodoStoreSnapshot {
    const todos = this.list();
    const counts: Record<TodoStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0
    };
    for (const item of todos) {
      counts[item.status] += 1;
    }
    return { todos, counts };
  }

  /** Subscribe to list changes (for TUI refresh). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  write(input: TodoWriteInput): TodoStoreSnapshot {
    const incoming = input.todos.map(normalizeTodoItem);
    const merge = input.merge !== false;

    if (!merge) {
      this.items = dedupeById(incoming);
      this.emitChange();
      return this.snapshot();
    }

    const map = new Map(this.items.map((item) => [item.id, item]));
    for (const item of incoming) {
      map.set(item.id, item);
    }
    this.items = [...map.values()];
    this.emitChange();
    return this.snapshot();
  }

  clear(): void {
    this.items = [];
    this.emitChange();
  }

  restore(todos: TodoItem[]): TodoStoreSnapshot {
    this.items = dedupeById(todos.map(normalizeTodoItem));
    this.emitChange();
    return this.snapshot();
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Prompt-friendly block for context injection. */
  formatForPrompt(): string {
    if (this.items.length === 0) {
      return '';
    }
    const lines = this.items.map(
      (item) => `${STATUS_MARK[item.status]} ${item.id}: ${item.content}`
    );
    const { counts } = this.snapshot();
    return [
      'Session todo list (update via TodoWrite; mark in_progress/completed as you work):',
      ...lines,
      `Progress: ${counts.completed}/${this.items.length} completed, ${counts.in_progress} in progress, ${counts.pending} pending.`
    ].join('\n');
  }
}

export function isTodoStatus(value: string): value is TodoStatus {
  return (TODO_STATUSES as readonly string[]).includes(value);
}

function normalizeTodoItem(item: TodoItem): TodoItem {
  const id = item.id.trim();
  const content = item.content.trim();
  if (!id) {
    throw new Error('Todo id must not be empty');
  }
  if (!content) {
    throw new Error(`Todo content must not be empty (id=${id})`);
  }
  if (!isTodoStatus(item.status)) {
    throw new Error(`Invalid todo status for ${id}: ${item.status}`);
  }
  return { id, content, status: item.status };
}

function dedupeById(items: TodoItem[]): TodoItem[] {
  const map = new Map<string, TodoItem>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return [...map.values()];
}
