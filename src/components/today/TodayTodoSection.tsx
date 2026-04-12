import { useMemo, useState } from "react";

import type { ProjectListItem, TodoPriority, TodoRecord } from "../../lib/types";
import { EmptyState, SectionHeader, SurfaceCard } from "../../ui/components";
import { TodoList } from "../todo/TodoList";
import { TodoSortSwitch } from "../todo/TodoSortSwitch";
import {
  priorityColorValue,
  sortTodos,
  TODO_PRIORITY_OPTIONS,
  type TodoSortMode,
} from "../todo/todo-utils";

interface TodayTodoSectionProps {
  projects: ProjectListItem[];
  todos: TodoRecord[];
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onDeleteTodo: (todoId: number) => Promise<unknown> | void;
  onOpenTodoSource: (todo: TodoRecord) => void;
  onError?: (message: string) => void;
}

export function TodayTodoSection({
  projects,
  todos,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onAddProgress,
  onDeleteTodo,
  onOpenTodoSource,
  onError,
}: TodayTodoSectionProps) {
  const [tab, setTab] = useState<"unfinished" | "finished">("unfinished");
  const [sortMode, setSortMode] = useState<TodoSortMode>("time");
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | null>(null);
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(() => new Set());

  const activityNameById = useMemo(
    () =>
      new Map(
        todos.flatMap((todo) =>
          todo.activityId && todo.sourceActivityTitle
            ? ([[todo.activityId, todo.sourceActivityTitle]] as const)
            : [],
        ),
      ),
    [todos],
  );
  const unfinishedCount = useMemo(
    () => todos.filter((todo) => todo.status === "unfinished").length,
    [todos],
  );
  const finishedCount = todos.length - unfinishedCount;
  const filteredTodos = useMemo(() => {
    const nextTabTodos = todos.filter((todo) => todo.status === tab);
    return priorityFilter === null
      ? nextTabTodos
      : nextTabTodos.filter((todo) => todo.priority === priorityFilter);
  }, [priorityFilter, tab, todos]);
  const groupedTodos = useMemo(
    () =>
      projects
        .map((project) => ({
          project,
          todos: sortTodos(
            filteredTodos.filter((todo) => todo.projectId === project.id),
            sortMode,
          ),
          totalUnfinished: todos.filter(
            (todo) => todo.projectId === project.id && todo.status === "unfinished",
          ).length,
          totalFinished: todos.filter(
            (todo) => todo.projectId === project.id && todo.status === "finished",
          ).length,
        }))
        .filter((group) => group.todos.length > 0),
    [filteredTodos, projects, sortMode, todos],
  );
  const showSortSwitch = filteredTodos.length > 1;

  function toggleExpanded(todoId: number, nextExpanded?: boolean) {
    setExpandedTodoIds((current) => {
      const next = new Set(current);
      const shouldExpand = nextExpanded ?? !next.has(todoId);

      if (shouldExpand) {
        next.add(todoId);
      } else {
        next.delete(todoId);
      }

      return next;
    });
  }

  return (
    <section className="grid gap-4">
      <SectionHeader
        eyebrow="Workspace Todo"
        title="To Do List"
        description="按项目汇总整个工作区的待办，集中处理需要推进和更新的事项。"
      />

      <SurfaceCard className="grid gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center rounded-full border border-border bg-bg p-1">
            <TodayTabButton active={tab === "unfinished"} onClick={() => setTab("unfinished")}>
              未完成
            </TodayTabButton>
            <TodayTabButton active={tab === "finished"} onClick={() => setTab("finished")}>
              已完成
            </TodayTabButton>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <div className="flex items-center gap-1">
              {TODO_PRIORITY_OPTIONS.map((option) => (
                <PriorityPillButton
                  key={option.value}
                  active={priorityFilter === option.value}
                  priority={option.value}
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

          <div className="flex items-center gap-3">
            <p className="text-ui text-text-soft">
              {unfinishedCount} 未完成 · {finishedCount} 已完成
            </p>
            {showSortSwitch ? <TodoSortSwitch value={sortMode} onChange={setSortMode} /> : null}
          </div>
        </div>

        {groupedTodos.length > 0 ? (
          <div className="grid gap-3">
            {groupedTodos.map((group) => (
              <SurfaceCard key={group.project.id} subtle className="grid gap-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-body font-medium text-text">{group.project.name}</h3>
                    <p className="text-ui text-text-soft">
                      {group.totalUnfinished} 未完成 · {group.totalFinished} 已完成
                    </p>
                  </div>
                  <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                    {group.todos.length} 项
                  </p>
                </div>

                <TodoList
                  todos={group.todos}
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
                  onDeleteTodo={onDeleteTodo}
                  onOpenTodoSource={onOpenTodoSource}
                  onError={onError}
                />
              </SurfaceCard>
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            title="当前没有需要展示的 Todo"
            text={
              tab === "unfinished"
                ? "还没有未完成事项，或当前筛选条件下没有匹配结果。"
                : "还没有已完成事项，或当前筛选条件下没有匹配结果。"
            }
          />
        )}
      </SurfaceCard>
    </section>
  );
}

function TodayTabButton({
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
      className={[
        "flex-1 rounded-full px-3 py-1.5 text-ui font-medium transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
        active ? "bg-bg-subtle text-text" : "text-text-soft hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      {children}
    </button>
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
