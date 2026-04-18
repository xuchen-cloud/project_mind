import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Check, Circle, Pencil, Trash2 } from "lucide-react";

import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import type { TodoPriority, TodoProgressRecord, TodoRecord } from "../../lib/types";
import { ActionContextMenu, IconButton } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { TodoInlineContentEditor } from "./TodoInlineContentEditor";
import { TodoInlineProgressEditor } from "./TodoInlineProgressEditor";
import { TodoPriorityDropdown } from "./TodoPriorityDropdown";
import {
  formatFullDate,
  formatMonthDay,
  parseProgressInput,
  resolveTodoSourceMeta,
  sortTodoProgresses,
} from "./todo-utils";

export function TodoListItem({
  todo,
  isFirst = false,
  activityNameById,
  activityOptions,
  compact = false,
  allowInlineEdit = false,
  allowInlineProgress = false,
  expanded = false,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onUpdateActivity,
  onAddProgress,
  onUpdateProgress,
  onDeleteProgress,
  onOpenTodoSource,
  onToggleExpanded,
  onOpenContextMenu,
  onError,
}: {
  todo: TodoRecord;
  isFirst?: boolean;
  activityNameById: ReadonlyMap<number, string>;
  activityOptions: Array<{ id: number; title: string }>;
  compact?: boolean;
  allowInlineEdit?: boolean;
  allowInlineProgress?: boolean;
  expanded?: boolean;
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
  onOpenTodoSource: (todo: TodoRecord) => void;
  onToggleExpanded: (todoId: number, nextExpanded?: boolean) => void;
  onOpenContextMenu: (todoId: number, x: number, y: number) => void;
  onError?: (message: string) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [sourceSelecting, setSourceSelecting] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const sourceSelectRef = useRef<HTMLSelectElement | null>(null);
  const sortedProgresses = sortTodoProgresses(todo.progresses);
  const latestProgress = sortedProgresses[0] ?? null;
  const previousProgresses = sortedProgresses.slice(1);
  const sourceMeta = resolveTodoSourceMeta(todo.activityId, activityNameById);
  const canExpand = previousProgresses.length > 0;
  const canChangeSource = activityOptions.length > 0 || Boolean(todo.activityId);
  const expandedItemRef = useDismissOnOutside<HTMLElement>({
    enabled: expanded,
    onDismiss: () => onToggleExpanded(todo.id, false),
    ignoredRefs: [expandButtonRef],
    listenFocusIn: false,
  });

  useEffect(() => {
    if (!expanded || canExpand) {
      return;
    }

    onToggleExpanded(todo.id, false);
  }, [canExpand, expanded, onToggleExpanded, todo.id]);

  useEffect(() => {
    if (sourceSelecting) {
      sourceSelectRef.current?.focus();
    }
  }, [sourceSelecting]);

  async function handleToggle() {
    setToggling(true);
    try {
      await onToggleStatus(todo.id, todo.status === "finished" ? "unfinished" : "finished");
    } finally {
      setToggling(false);
    }
  }

  async function handleSourceChange(nextValue: string) {
    const nextActivityId = nextValue ? Number(nextValue) : null;
    const currentActivityId = todo.activityId ?? null;
    if (nextActivityId === currentActivityId) {
      setSourceSelecting(false);
      return;
    }

    setSourceSaving(true);
    try {
      await onUpdateActivity(todo.id, nextActivityId);
      setSourceSelecting(false);
    } finally {
      setSourceSaving(false);
    }
  }

  return (
    <article
      id={`todo-${todo.id}`}
      ref={expanded ? expandedItemRef : undefined}
      className={cn(
        "group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-3 transition-[background-color,opacity] duration-[160ms] ease-[var(--ease-soft)]",
        !isFirst && "border-t border-border",
        compact && "py-2.5",
        todo.status === "finished" ? "opacity-72" : "hover:bg-bg-hover",
      )}
      onContextMenu={(event) => {
        if (shouldIgnoreContextMenuTarget(event.target)) {
          return;
        }
        event.preventDefault();
        onOpenContextMenu(todo.id, event.clientX, event.clientY);
      }}
    >
      <div className="grid min-w-0 gap-2">
        <TodoInlineContentEditor
          value={todo.content}
          editable={allowInlineEdit}
          onSave={(content) => onUpdateContent(todo.id, content)}
        />

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption leading-4">
          <TodoPriorityDropdown
            priority={todo.priority}
            onSelect={(priority) => onUpdatePriority(todo.id, priority)}
          />
          <span className="text-text-soft">·</span>
          {sourceSelecting ? (
            <select
              ref={sourceSelectRef}
              aria-label="选择归属 Activity"
              value={todo.activityId ?? ""}
              disabled={sourceSaving}
              className="h-7 min-w-[8rem] max-w-full rounded-[var(--radius-6)] border border-border bg-bg px-2 text-caption text-text outline-none transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              onBlur={() => {
                if (!sourceSaving) {
                  setSourceSelecting(false);
                }
              }}
              onChange={(event) => {
                void handleSourceChange(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSourceSelecting(false);
                }
              }}
            >
              <option value="">项目级 Todo</option>
              {activityOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              {sourceMeta.kind === "activity" ? (
                <button
                  type="button"
                  className="max-w-full truncate bg-transparent text-text-soft transition-colors hover:text-text"
                  onClick={() => onOpenTodoSource(todo)}
                >
                  {sourceMeta.label}
                </button>
              ) : (
                <span className="truncate text-text-soft">{sourceMeta.label}</span>
              )}
              {canChangeSource ? (
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-transparent text-text-soft transition-colors hover:text-text"
                  aria-label="修改归属 Activity"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSourceSelecting(true);
                  }}
                >
                  <ChevronDown size={12} />
                </button>
              ) : null}
            </div>
          )}
        </div>

        <TodoInlineProgressEditor
          latestProgress={
            latestProgress
              ? {
                  id: latestProgress.id,
                  content: latestProgress.content,
                  progressDate: latestProgress.progressDate,
                }
              : null
          }
          editable={allowInlineProgress}
          onError={onError}
          onSave={(payload) => onAddProgress(todo.id, payload)}
          onUpdateLatestProgress={onUpdateProgress}
          onDeleteLatestProgress={onDeleteProgress}
        />

        {expanded && canExpand ? (
          <div className="mt-1 border-t border-border">
            <div className="grid">
              {previousProgresses.map((progress, index) => (
                <TodoHistoryProgressItem
                  key={progress.id}
                  progress={progress}
                  editable={allowInlineProgress}
                  bordered={index > 0}
                  onUpdateProgress={onUpdateProgress}
                  onDeleteProgress={onDeleteProgress}
                  onError={onError}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-0.5 flex self-stretch flex-col items-center gap-1">
        <IconButton
          type="button"
          variant={todo.status === "finished" ? "subtle" : "secondary"}
          size="sm"
          className="rounded-full opacity-70 group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={todo.status === "finished" ? "标记为未完成" : "标记为已完成"}
          disabled={toggling}
          onClick={() => {
            void handleToggle();
          }}
        >
          {todo.status === "finished" ? <Check size={13} /> : <Circle size={13} />}
        </IconButton>
        <IconButton
          ref={expandButtonRef}
          type="button"
          size="sm"
          variant="ghost"
          className="mt-auto opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={expanded ? "收起历史进展" : "展开历史进展"}
          disabled={!canExpand}
          onClick={() => onToggleExpanded(todo.id)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </IconButton>
      </div>
    </article>
  );
}

function TodoHistoryProgressItem({
  progress,
  editable,
  bordered,
  onUpdateProgress,
  onDeleteProgress,
  onError,
}: {
  progress: TodoProgressRecord;
  editable: boolean;
  bordered: boolean;
  onUpdateProgress: (
    progressId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onDeleteProgress: (progressId: number) => Promise<unknown> | void;
  onError?: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(progress.content);
  const [saving, setSaving] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveInFlightRef = useRef(false);
  const skipBlurSaveRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraft(progress.content);
    }
  }, [editing, progress.content]);

  useEffect(() => {
    if (!editing || !textareaRef.current) {
      return;
    }

    const textarea = textareaRef.current;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft, editing]);

  async function handleSave() {
    if (saveInFlightRef.current) {
      return;
    }

    const normalizedDraft = normalizeProgressDraft(draft).trim();
    if (!normalizedDraft || /^@\d{4}$/u.test(normalizedDraft)) {
      setEditing(false);
      return;
    }

    const parsed = parseProgressInput(normalizedDraft, new Date(), progress.progressDate);
    if (!parsed.ok) {
      onError?.(parsed.error);
      return;
    }

    saveInFlightRef.current = true;
    setSaving(true);
    try {
      await onUpdateProgress(progress.id, {
        content: parsed.content,
        progressDate: parsed.progressDate,
      });
      setEditing(false);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className={cn("grid gap-2 py-2", bordered && "border-t border-border")}>
        <textarea
          ref={textareaRef}
          rows={1}
          className="min-h-8 w-full resize-none overflow-hidden rounded-[var(--radius-6)] border border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-2.5 py-1.5 text-ui leading-5 text-text outline-none"
          value={draft}
          autoFocus
          disabled={saving}
          placeholder="@0315 已与财务确认方案"
          onChange={(event) => setDraft(normalizeProgressDraft(event.target.value))}
          onBlur={() => {
            if (skipBlurSaveRef.current) {
              skipBlurSaveRef.current = false;
              return;
            }
            void handleSave();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              skipBlurSaveRef.current = true;
              setEditing(false);
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    );
  }

  return (
    <article
      className={cn("py-2", bordered && "border-t border-border")}
      onContextMenu={(event) => {
        if (!editable || shouldIgnoreContextMenuTarget(event.target)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <p className="text-ui leading-5 text-text-muted">
        <span className="break-words">{progress.content}</span>
        <span
          className="ml-2 text-caption text-text-soft"
          title={formatFullDate(progress.progressDate)}
        >
          {formatMonthDay(progress.progressDate)}
        </span>
      </p>
      {contextMenu ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="历史进展操作"
          onClose={() => setContextMenu(null)}
          actions={[
            {
              icon: Pencil,
              label: "编辑进展",
              onSelect: () => {
                setEditing(true);
              },
            },
            {
              icon: Trash2,
              label: "删除进展",
              tone: "danger",
              onSelect: () => {
                void onDeleteProgress(progress.id);
              },
            },
          ]}
        />
      ) : null}
    </article>
  );
}

function normalizeProgressDraft(value: string) {
  return value.replace(/\r?\n+/gu, " ");
}
