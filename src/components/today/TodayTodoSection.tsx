import { useMemo, useState } from "react";

import type { ProjectListItem, TodoPriority, TodoRecord } from "../../lib/types";
import { Button, EmptyState, SectionHeader, SurfaceCard, TextField } from "../../ui/components";
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
  activityOptionsByProject: ReadonlyMap<number, Array<{ id: number; title: string }>>;
  todos: TodoRecord[];
  onCreateTodo: (payload: {
    projectId: number;
    activityId?: number;
    content: string;
    priority: TodoPriority;
  }) => void;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onUpdateActivity: (todoId: number, activityId: number | null) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onUpdateProgress: (
    progressId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onDeleteProgress: (progressId: number) => Promise<unknown> | void;
  onDeleteTodo: (todoId: number) => Promise<unknown> | void;
  onOpenTodoSource: (todo: TodoRecord) => void;
  onError?: (message: string) => void;
}

export function TodayTodoSection({
  projects,
  activityOptionsByProject,
  todos,
  onCreateTodo,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onUpdateActivity,
  onAddProgress,
  onUpdateProgress,
  onDeleteProgress,
  onDeleteTodo,
  onOpenTodoSource,
  onError,
}: TodayTodoSectionProps) {
  const [tab, setTab] = useState<"unfinished" | "finished">("unfinished");
  const [sortMode, setSortMode] = useState<TodoSortMode>("time");
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | null>(null);
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(() => new Set());
  const [draftContent, setDraftContent] = useState("");
  const [draftPriority, setDraftPriority] = useState<TodoPriority>("not_urgent_important");
  const [draftProjectId, setDraftProjectId] = useState<number | null>(null);
  const [draftActivityId, setDraftActivityId] = useState<number | null>(null);

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
  const draftActivityOptions = useMemo(
    () => (draftProjectId === null ? [] : activityOptionsByProject.get(draftProjectId) ?? []),
    [activityOptionsByProject, draftProjectId],
  );

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

  function submitCreate() {
    const content = draftContent.trim();
    if (!content || draftProjectId === null) {
      return;
    }

    onCreateTodo({
      projectId: draftProjectId,
      ...(draftActivityId !== null ? { activityId: draftActivityId } : {}),
      content,
      priority: draftPriority,
    });
    setDraftContent("");
    setDraftActivityId(null);
    setDraftPriority("not_urgent_important");
  }

  return (
    <section className="grid gap-4">
      <SectionHeader
        eyebrow="Workspace Todo"
        title="To Do List"
        description="按项目汇总整个工作区的待办，集中处理需要推进和更新的事项。"
      />

      <SurfaceCard className="grid gap-4 p-4">
        <SurfaceCard subtle className="grid gap-3 p-3">
          <div className="grid gap-1">
            <p className="text-ui font-medium text-text">新增 Todo</p>
            <p className="text-ui leading-5 text-text-soft">
              在 Today 里新增待办时，必须选择归属项目，也可以顺手绑定到具体 Activity。
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_11rem_13rem_auto] md:items-end">
            <label className="grid gap-1.5">
              <span className="text-ui font-medium text-text-muted">内容</span>
              <TextField
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitCreate();
                  }
                }}
                placeholder="例如：整理本周访谈结论"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-ui font-medium text-text-muted">项目</span>
              <select
                aria-label="选择归属项目"
                value={draftProjectId ?? ""}
                className="h-8 w-full rounded-[var(--radius-6)] border border-border bg-bg px-3 text-body text-text outline-none transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent"
                onChange={(event) => {
                  const nextValue = event.target.value;
                  const nextProjectId = nextValue ? Number(nextValue) : null;
                  setDraftProjectId(nextProjectId);
                  setDraftActivityId(null);
                }}
              >
                <option value="">选择项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1.5">
              <span className="text-ui font-medium text-text-muted">Activity</span>
              <select
                aria-label="选择归属 Activity"
                value={draftActivityId ?? ""}
                disabled={draftProjectId === null}
                className="h-8 w-full rounded-[var(--radius-6)] border border-border bg-bg px-3 text-body text-text outline-none transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setDraftActivityId(nextValue ? Number(nextValue) : null);
                }}
              >
                <option value="">项目级 Todo</option>
                {draftActivityOptions.map((activity) => (
                  <option key={activity.id} value={activity.id}>
                    {activity.title}
                  </option>
                ))}
              </select>
            </label>

            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!draftContent.trim() || draftProjectId === null}
              onClick={submitCreate}
            >
              新增 Todo
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {TODO_PRIORITY_OPTIONS.map((option) => (
              <PriorityPillButton
                key={option.value}
                active={draftPriority === option.value}
                priority={option.value}
                title={option.optionLabel}
                onClick={() => setDraftPriority(option.value)}
              >
                {option.code}
              </PriorityPillButton>
            ))}
          </div>
        </SurfaceCard>

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
                  activityOptions={activityOptionsByProject.get(group.project.id) ?? []}
                  compact
                  allowInlineEdit={tab === "unfinished"}
                  allowInlineProgress={tab === "unfinished"}
                  expandedTodoIds={expandedTodoIds}
                  onToggleExpanded={toggleExpanded}
                  emptyText={tab === "unfinished" ? "当前没有未完成 Todo。" : "当前没有已完成 Todo。"}
                  onToggleStatus={onToggleStatus}
                  onUpdatePriority={onUpdatePriority}
                  onUpdateContent={onUpdateContent}
                  onUpdateActivity={onUpdateActivity}
                  onAddProgress={onAddProgress}
                  onUpdateProgress={onUpdateProgress}
                  onDeleteProgress={onDeleteProgress}
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
