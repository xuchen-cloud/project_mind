import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, Plus } from "lucide-react";

import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
  findInternalReferenceTextTrigger,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import { resolveActivityTitle } from "../../lib/constants";
import type { ProjectListItem, TodoPriority, TodoRecord } from "../../lib/types";
import {
  Button,
  EmptyState,
  IconButton,
  SectionHeader,
  SurfaceCard,
  TextField,
} from "../../ui/components";
import { InternalReferencePicker, useInternalReferenceSearch } from "../internal-reference";
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
  onOpenProject: (projectId: number) => void;
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
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
}

export function TodayTodoSection({
  projects,
  activityOptionsByProject,
  todos,
  onOpenProject,
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
  onOpenInternalReference,
}: TodayTodoSectionProps) {
  const [tab, setTab] = useState<"unfinished" | "finished">("unfinished");
  const [sortMode, setSortMode] = useState<TodoSortMode>("time");
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | null>(null);
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(() => new Set());
  const [composeProjectId, setComposeProjectId] = useState<number | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [draftPriority, setDraftPriority] = useState<TodoPriority>("not_urgent_important");
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [referenceActiveIndex, setReferenceActiveIndex] = useState(0);
  const [dismissedTriggerKey, setDismissedTriggerKey] = useState<string | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const referenceTrigger =
    composeProjectId !== null ? findInternalReferenceTextTrigger(draftContent, selectionStart) : null;
  const referenceTriggerKey = referenceTrigger
    ? `${referenceTrigger.start}:${referenceTrigger.end}:${referenceTrigger.query}`
    : null;
  const referencePickerOpen =
    Boolean(referenceTrigger) && dismissedTriggerKey !== referenceTriggerKey;
  const { results: referenceResults, loading: referenceLoading } = useInternalReferenceSearch({
    open: referencePickerOpen,
    query: referenceTrigger?.query ?? "",
    context:
      composeProjectId === null
        ? null
        : { scope: "project", projectId: composeProjectId },
    limit: 8,
  });

  const activityNameById = useMemo(
    () =>
      new Map(
        todos.flatMap((todo) =>
          todo.activityId &&
          todo.sourceActivityTitle !== undefined &&
          todo.sourceActivityTitle !== null
            ? ([
                [
                  todo.activityId,
                  resolveActivityTitle(todo.sourceActivityTitle, todo.activityId),
                ],
              ] as const)
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
  const projectGroups = useMemo(
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
        })),
    [filteredTodos, projects, sortMode, todos],
  );
  const showSortSwitch = filteredTodos.length > 1;
  const visibleGroups = useMemo(
    () =>
      tab === "unfinished"
        ? projectGroups
        : projectGroups.filter((group) => group.todos.length > 0),
    [projectGroups, tab],
  );

  useEffect(() => {
    if (!referencePickerOpen) {
      setReferenceActiveIndex(0);
      return;
    }

    setReferenceActiveIndex((current) => {
      if (referenceResults.length === 0) {
        return 0;
      }

      return Math.min(current, referenceResults.length - 1);
    });
  }, [referencePickerOpen, referenceResults.length]);

  useEffect(() => {
    if (!referencePickerOpen) {
      return;
    }

    setReferenceActiveIndex(0);
  }, [referencePickerOpen, referenceTrigger?.query]);
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

  function openComposer(projectId: number) {
    setComposeProjectId((current) => {
      const nextProjectId = current === projectId ? null : projectId;

      if (nextProjectId === null) {
        setDraftContent("");
        setDraftPriority("not_urgent_important");
        setSelectionStart(null);
        setDismissedTriggerKey(null);
      } else if (current !== projectId) {
        setDraftContent("");
        setDraftPriority("not_urgent_important");
        setSelectionStart(null);
        setDismissedTriggerKey(null);
      }

      return nextProjectId;
    });
  }

  function submitCreate(projectId: number) {
    const content = draftContent.trim();
    if (!content) {
      return;
    }

    onCreateTodo({
      projectId,
      content,
      priority: draftPriority,
    });
    setDraftContent("");
    setComposeProjectId(null);
    setDraftPriority("not_urgent_important");
    setSelectionStart(null);
    setDismissedTriggerKey(null);
  }

  function handleReferenceInsert(reference: {
    kind: "note" | "conclusion" | "todo" | "document";
    id: number;
    label: string;
  }) {
    if (!referenceTrigger) {
      return;
    }

    const target = buildInternalReferenceTarget(reference);
    const token = `${buildInternalReferenceToken(target)} `;
    const nextContent =
      draftContent.slice(0, referenceTrigger.start) +
      token +
      draftContent.slice(referenceTrigger.end);
    const nextSelection = referenceTrigger.start + token.length;

    setDraftContent(nextContent);
    setSelectionStart(nextSelection);
    setDismissedTriggerKey(null);

    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
      composerInputRef.current?.setSelectionRange(nextSelection, nextSelection);
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

        {projects.length === 0 ? (
          <EmptyState text="还没有可用项目。" compact />
        ) : visibleGroups.length > 0 ? (
          <div className="grid gap-3">
            {visibleGroups.map((group) => (
              <SurfaceCard key={group.project.id} subtle className="grid gap-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="min-w-0 rounded-[var(--radius-6)] bg-transparent text-left text-body font-medium text-text transition-colors hover:text-accent"
                        onClick={() => onOpenProject(group.project.id)}
                      >
                        {group.project.name}
                      </button>
                      {tab === "unfinished" ? (
                        <IconButton
                          type="button"
                          size="sm"
                          variant={composeProjectId === group.project.id ? "secondary" : "ghost"}
                          aria-label={`${group.project.name} 新建 Todo`}
                          onClick={() => openComposer(group.project.id)}
                        >
                          <Plus size={14} />
                        </IconButton>
                      ) : null}
                    </div>
                    <p className="text-ui text-text-soft">
                      {group.totalUnfinished} 未完成 · {group.totalFinished} 已完成
                    </p>
                  </div>
                  <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                    {group.todos.length} 项
                  </p>
                </div>

                {composeProjectId === group.project.id ? (
                  <div className="grid gap-3 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="relative min-w-0 flex-1">
                        <TextField
                          ref={composerInputRef}
                          className="min-w-0 flex-1"
                          value={draftContent}
                          onChange={(event) => {
                            setDraftContent(event.target.value);
                            setSelectionStart(event.target.selectionStart);
                          }}
                          onClick={(event) => setSelectionStart(event.currentTarget.selectionStart)}
                          onKeyUp={(event) => setSelectionStart(event.currentTarget.selectionStart)}
                          onSelect={(event) => setSelectionStart(event.currentTarget.selectionStart)}
                          onKeyDown={(event) => {
                            if (referencePickerOpen && composeProjectId === group.project.id) {
                              if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setReferenceActiveIndex((current) => {
                                  if (referenceResults.length === 0) {
                                    return 0;
                                  }

                                  return (current + 1) % referenceResults.length;
                                });
                                return;
                              }

                              if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setReferenceActiveIndex((current) => {
                                  if (referenceResults.length === 0) {
                                    return 0;
                                  }

                                  return current === 0 ? referenceResults.length - 1 : current - 1;
                                });
                                return;
                              }

                              if (event.key === "Enter" && referenceResults.length > 0) {
                                event.preventDefault();
                                handleReferenceInsert(
                                  referenceResults[referenceActiveIndex] ?? referenceResults[0],
                                );
                                return;
                              }

                              if (event.key === "Escape") {
                                event.preventDefault();
                                setDismissedTriggerKey(referenceTriggerKey);
                                return;
                              }
                            }

                            if (event.key === "Enter") {
                              event.preventDefault();
                              submitCreate(group.project.id);
                            }
                          }}
                          placeholder={`在 ${group.project.name} 里新增一条 Todo`}
                        />
                        <InternalReferencePicker
                          open={referencePickerOpen && composeProjectId === group.project.id}
                          loading={referenceLoading}
                          results={referenceResults}
                          activeIndex={referenceActiveIndex}
                          className="absolute left-0 top-[calc(100%+6px)] z-20 w-[22rem]"
                          onHoverIndex={setReferenceActiveIndex}
                          onSelect={handleReferenceInsert}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={!draftContent.trim()}
                        onClick={() => submitCreate(group.project.id)}
                      >
                        保存
                      </Button>
                      <IconButton
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`${group.project.name} 收起新建 Todo`}
                        title="收起"
                        onClick={() => openComposer(group.project.id)}
                      >
                        <ChevronUp size={14} />
                      </IconButton>
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
                  </div>
                ) : null}

                {group.todos.length > 0 || composeProjectId !== group.project.id ? (
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
                    onOpenInternalReference={onOpenInternalReference}
                    onEmptyClick={
                      tab === "unfinished"
                        ? () => {
                            openComposer(group.project.id);
                          }
                        : undefined
                    }
                  />
                ) : null}
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
