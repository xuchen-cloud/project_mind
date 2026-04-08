import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ListTodo, Plus } from "lucide-react";

import type { TodoPriority, TodoRecord } from "../../lib/types";
import { useUiStore } from "../../state/ui-store";
import { Button, IconButton, SurfaceCard, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { TodoList } from "./TodoList";
import { TodoSortSwitch } from "./TodoSortSwitch";
import {
  priorityColorValue,
  sortTodos,
  TODO_PRIORITY_OPTIONS,
  type TodoSortMode,
} from "./todo-utils";

interface TodoRailProps {
  title: string;
  scopeLabel: string;
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
  activityNameById: ReadonlyMap<number, string>;
  createPlaceholder: string;
  onCreateTodo: (payload: { content: string; priority: TodoPriority }) => void;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onOpenTodoSource: (todo: TodoRecord) => void;
  onError?: (message: string) => void;
}

function RailTabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex-1 rounded-full px-3 py-1.5 text-ui font-medium transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
        active ? "bg-bg-subtle text-text" : "text-text-soft hover:text-text",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function TodoRail({
  title,
  scopeLabel,
  unfinishedTodos,
  finishedTodos,
  activityNameById,
  createPlaceholder,
  onCreateTodo,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onAddProgress,
  onOpenTodoSource,
  onError,
}: TodoRailProps) {
  const { todoRailCollapsed, setTodoRailCollapsed, toggleTodoRailCollapsed } = useUiStore();
  const [tab, setTab] = useState<"unfinished" | "finished">("unfinished");
  const [sortMode, setSortMode] = useState<TodoSortMode>("time");
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [content, setContent] = useState("");
  const [priority, setPriority] = useState<TodoPriority>("not_urgent_important");
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(() => new Set());

  const tabTodos = tab === "unfinished" ? unfinishedTodos : finishedTodos;
  const todos = useMemo(() => {
    const filteredTodos =
      priorityFilter === null
        ? tabTodos
        : tabTodos.filter((todo) => todo.priority === priorityFilter);
    return sortTodos(filteredTodos, sortMode);
  }, [priorityFilter, sortMode, tabTodos]);
  const showSortSwitch = todos.length > 1;
  const summaryText = useMemo(
    () => `${unfinishedTodos.length} 未完成 · ${finishedTodos.length} 已完成`,
    [finishedTodos.length, unfinishedTodos.length],
  );

  function submitCreate() {
    if (!content.trim()) {
      return;
    }
    onCreateTodo({ content: content.trim(), priority });
    setContent("");
    setPriority("not_urgent_important");
    setIsComposing(false);
  }

  function toggleExpanded(todoId: number) {
    setExpandedTodoIds((current) => {
      const next = new Set(current);
      if (next.has(todoId)) {
        next.delete(todoId);
      } else {
        next.add(todoId);
      }
      return next;
    });
  }

  if (todoRailCollapsed) {
    return (
      <aside
        className="flex w-14 shrink-0 flex-col items-center gap-3 border-l border-border bg-bg-subtle px-2 py-3 transition-[width] duration-[160ms] ease-[var(--ease-soft)]"
        aria-label={`${title} 侧边栏`}
      >
        <IconButton
          type="button"
          size="sm"
          aria-label="展开代办侧边栏"
          onClick={toggleTodoRailCollapsed}
        >
          <ChevronLeft size={14} />
        </IconButton>

        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-8)] border border-border bg-bg text-text-muted transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong hover:bg-bg-hover hover:text-text"
          title={`${title} · ${summaryText}`}
          onClick={() => setTodoRailCollapsed(false)}
        >
          <ListTodo size={16} />
        </button>

        <div className="grid gap-2 text-center">
          <div className="rounded-[var(--radius-8)] bg-bg px-2 py-2">
            <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              未完成
            </p>
            <p className="mt-1 text-ui font-medium text-text">{unfinishedTodos.length}</p>
          </div>
          <div className="rounded-[var(--radius-8)] bg-bg px-2 py-2">
            <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              已完成
            </p>
            <p className="mt-1 text-ui font-medium text-text">{finishedTodos.length}</p>
          </div>
        </div>

        <IconButton
          type="button"
          size="sm"
          aria-label="新增代办"
          onClick={() => {
            setTodoRailCollapsed(false);
            setIsComposing(true);
          }}
        >
          <Plus size={14} />
        </IconButton>
      </aside>
    );
  }

  return (
    <aside
      className="flex w-[22rem] shrink-0 flex-col border-l border-border bg-bg-subtle transition-[width] duration-[160ms] ease-[var(--ease-soft)]"
      aria-label={`${title} 侧边栏`}
    >
      <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-4">
        <div className="min-w-0 flex-1">
          <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
            Todo List
          </p>
          <h2 className="mt-1 text-title font-medium text-text">{title}</h2>
          <p className="mt-1 text-body font-medium leading-6 text-text">{scopeLabel}</p>
          <p className="text-ui text-text-soft">{summaryText}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            type="button"
            size="sm"
            variant="secondary"
            aria-label="新增代办"
            onClick={() => setIsComposing((value) => !value)}
          >
            <Plus size={14} />
          </IconButton>
          <IconButton
            type="button"
            size="sm"
            aria-label="收起代办侧边栏"
            onClick={toggleTodoRailCollapsed}
          >
            <ChevronRight size={14} />
          </IconButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center rounded-full border border-border bg-bg p-1">
            <RailTabButton active={tab === "unfinished"} onClick={() => setTab("unfinished")}>
              未完成
            </RailTabButton>
            <RailTabButton active={tab === "finished"} onClick={() => setTab("finished")}>
              已完成
            </RailTabButton>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <div className="flex items-center gap-1">
              {TODO_PRIORITY_OPTIONS.map((option) => (
                <PriorityPillButton
                  key={option.value}
                  priority={option.value}
                  active={priorityFilter === option.value}
                  title={option.optionLabel}
                  onClick={() =>
                    setPriorityFilter((current) => (current === option.value ? null : option.value))
                  }
                >
                  {option.code}
                </PriorityPillButton>
              ))}
            </div>
          </div>

          {showSortSwitch ? <TodoSortSwitch value={sortMode} onChange={setSortMode} /> : null}
        </div>

        {isComposing ? (
          <SurfaceCard className="mb-3 grid gap-2 p-3">
            <TextField
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitCreate();
                }
              }}
              placeholder={createPlaceholder}
            />
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-1 flex-wrap items-center gap-1.5">
                {TODO_PRIORITY_OPTIONS.map((option) => (
                  <PriorityPillButton
                    key={option.value}
                    priority={option.value}
                    active={priority === option.value}
                    title={option.optionLabel}
                    onClick={() => setPriority(option.value)}
                  >
                    {option.code}
                  </PriorityPillButton>
                ))}
              </div>
              <Button type="button" size="sm" variant="primary" onClick={submitCreate}>
                保存
              </Button>
            </div>
          </SurfaceCard>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <TodoList
            todos={todos}
            activityNameById={activityNameById}
            compact
            allowInlineEdit={tab === "unfinished"}
            allowInlineProgress={tab === "unfinished"}
            expandedTodoIds={expandedTodoIds}
            onToggleExpanded={toggleExpanded}
            emptyText={tab === "unfinished" ? "当前没有未完成 Todo。" : "当前没有已完成 Todo。"}
            onToggleStatus={onToggleStatus}
            onUpdatePriority={onUpdatePriority}
            onUpdateContent={onUpdateContent}
            onAddProgress={onAddProgress}
            onOpenTodoSource={onOpenTodoSource}
            onError={onError}
          />
        </div>
      </div>
    </aside>
  );
}

function PriorityPillButton({
  active,
  children,
  priority,
  title,
  onClick,
}: {
  active: boolean;
  children: string;
  priority: TodoPriority;
  title?: string;
  onClick: () => void;
}) {
  const colorValue = priorityColorValue(priority);

  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      className="h-7 rounded-full border px-2.5 text-caption font-medium tracking-[0.1em] transition-[background-color,border-color,color,opacity] duration-[160ms] ease-[var(--ease-soft)] hover:opacity-100"
      style={{
        borderColor: `color-mix(in srgb, ${colorValue} ${active ? 28 : 18}%, var(--color-border))`,
        backgroundColor: active
          ? `color-mix(in srgb, ${colorValue} 16%, var(--color-bg))`
          : `color-mix(in srgb, ${colorValue} 6%, var(--color-bg))`,
        color: colorValue,
        opacity: active ? 1 : 0.82,
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
