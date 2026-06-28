import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronUp, Check, Circle, Pencil, Trash2 } from "lucide-react";

import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import {
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import type { ContactMentionTarget } from "../../lib/contactMentions";
import type {
  FileTagRecord,
  TodoPriority,
  TodoProgressRecord,
  TodoRecord,
} from "../../lib/types";
import { ActionContextMenu, IconButton, type ContextMenuAction } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  InternalReferenceInlineText,
} from "../internal-reference";
import { TodoInlineContentEditor } from "./TodoInlineContentEditor";
import { TodoInlineProgressEditor } from "./TodoInlineProgressEditor";
import { TodoProgressTextEditor } from "./TodoProgressTextEditor";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import {
  parseProgressInput,
  priorityColorValue,
  sortTodoProgresses,
} from "./todo-utils";

const PROGRESS_STATUS_TRANSITION_MS = 420;

type ProgressVisualState = "completing" | "restoring" | null;

export function TodoListItem({
  todo,
  isFirst = false,
  compact = false,
  allowInlineEdit = false,
  allowInlineProgress = false,
  expanded = false,
  statusTransition = null,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onUpdateTags,
  onAddProgress,
  onUpdateProgress,
  onDeleteProgress,
  onToggleExpanded,
  onOpenContextMenu,
  onError,
  onOpenInternalReference,
  onOpenContactMention,
  availableTags = [],
}: {
  todo: TodoRecord;
  isFirst?: boolean;
  compact?: boolean;
  allowInlineEdit?: boolean;
  allowInlineProgress?: boolean;
  expanded?: boolean;
  statusTransition?: "completing" | "restoring" | null;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onUpdateTags?: (todoId: number, tagIds: number[]) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onUpdateProgress: (
    progressId: number,
    payload: { content: string; progressDate: string; status?: TodoRecord["status"] },
  ) => Promise<unknown> | void;
  onDeleteProgress: (progressId: number) => Promise<unknown> | void;
  onToggleExpanded: (todoId: number, nextExpanded?: boolean) => void;
  onOpenContextMenu: (todoId: number, x: number, y: number) => void;
  onError?: (message: string) => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
  availableTags?: FileTagRecord[];
}) {
  const [toggling, setToggling] = useState(false);
  const [contentEditing, setContentEditing] = useState(false);
  const [progressEditing, setProgressEditing] = useState(false);
  const [progressTransitions, setProgressTransitions] = useState<
    Record<number, { progress: TodoProgressRecord; phase: ProgressVisualState }>
  >({});
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const progressTimersRef = useRef(new Map<number, number>());
  const todoState = [
    todo.status === "finished" ? "finished" : "unfinished",
    expanded ? "expanded" : "",
    contentEditing ? "editing" : "",
    progressEditing ? "progress-editing" : "",
    statusTransition ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const mergedProgresses = sortTodoProgresses([
    ...todo.progresses.map((progress) => progressTransitions[progress.id]?.progress ?? progress),
    ...Object.entries(progressTransitions)
      .filter(([progressId]) => !todo.progresses.some((progress) => progress.id === Number(progressId)))
      .map(([, transition]) => transition.progress),
  ]);
  const sortedProgresses = mergedProgresses;
  const unfinishedSubItems = sortedProgresses.filter(
    (progress) => progress.status !== "finished",
  );
  const visibleUnfinishedSubItems = sortedProgresses.filter((progress) => {
    const phase = progressTransitions[progress.id]?.phase;
    return progress.status !== "finished" || phase === "completing";
  });
  const finishedSubItems = sortedProgresses.filter(
    (progress) =>
      progress.status === "finished" && progressTransitions[progress.id]?.phase !== "completing",
  );
  const canExpand = finishedSubItems.length > 0;
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
    return () => {
      progressTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      progressTimersRef.current.clear();
    };
  }, []);

  function clearProgressTransition(progressId: number) {
    const timerId = progressTimersRef.current.get(progressId);
    if (timerId) {
      window.clearTimeout(timerId);
      progressTimersRef.current.delete(progressId);
    }

    setProgressTransitions((current) => {
      if (!current[progressId]) {
        return current;
      }

      const next = { ...current };
      delete next[progressId];
      return next;
    });
  }

  async function handleToggle() {
    setToggling(true);
    try {
      await onToggleStatus(todo.id, todo.status === "finished" ? "unfinished" : "finished");
    } finally {
      setToggling(false);
    }
  }

  async function handleProgressStatusToggle(
    progressId: number,
    progress: TodoProgressRecord,
    nextStatus: TodoRecord["status"],
  ) {
    const currentProgress =
      mergedProgresses.find((candidate) => candidate.id === progressId) ?? progress;
    const phase = nextStatus === "finished" ? "completing" : "restoring";
    const nextProgress = {
      ...currentProgress,
      status: nextStatus,
      completedAt:
        nextStatus === "finished"
          ? currentProgress.completedAt ?? new Date().toISOString()
          : null,
    };

    setProgressTransitions((current) => ({
      ...current,
      [progressId]: { progress: nextProgress, phase },
    }));

    const existingTimer = progressTimersRef.current.get(progressId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }
    progressTimersRef.current.set(
      progressId,
      window.setTimeout(() => clearProgressTransition(progressId), PROGRESS_STATUS_TRANSITION_MS),
    );

    try {
      await onUpdateProgress(progressId, {
        content: currentProgress.content,
        progressDate: currentProgress.progressDate,
        status: nextStatus,
      });
    } catch (error) {
      clearProgressTransition(progressId);
      throw error;
    }
  }

  function renderProgressItem(progress: TodoProgressRecord, bordered: boolean) {
    return (
      <TodoHistoryProgressItem
        key={progress.id}
        progress={progress}
        projectId={todo.projectId}
        editable={allowInlineProgress}
        bordered={bordered}
        showCheckbox
        visualState={progressTransitions[progress.id]?.phase ?? null}
        onUpdateProgress={onUpdateProgress}
        onDeleteProgress={onDeleteProgress}
        onToggleStatus={(progressId, nextStatus) =>
          handleProgressStatusToggle(progressId, progress, nextStatus)
        }
        onError={onError}
        onOpenInternalReference={onOpenInternalReference}
        onOpenContactMention={onOpenContactMention}
      />
    );
  }

  return (
    <article
      id={`todo-${todo.id}`}
      ref={expanded ? expandedItemRef : undefined}
      className="todo-card group"
      data-state={todoState}
      style={
        {
          "--todo-priority-color": priorityColorValue(todo.priority),
        } as CSSProperties
      }
      onContextMenu={(event) => {
        if (shouldIgnoreContextMenuTarget(event.target)) {
          return;
        }
        event.preventDefault();
        onOpenContextMenu(todo.id, event.clientX, event.clientY);
      }}
    >
      <div className={cn("todo-card__row", compact && "todo-card__row--compact")}>
        <div className="todo-card__main">
          <div className="todo-card__headline">
            <div className="todo-card__content">
              <TodoInlineContentEditor
                value={todo.content}
                editable={allowInlineEdit}
                internalReferenceContext={{ scope: "project", projectId: todo.projectId }}
                onOpenInternalReference={onOpenInternalReference}
                onOpenContactMention={onOpenContactMention}
                onEditingChange={setContentEditing}
                onSave={(content) => onUpdateContent(todo.id, content)}
              />
            </div>
            <button
              type="button"
              className={cn("todo-card__check", contentEditing && "todo-card__check--hidden")}
              aria-label={todo.status === "finished" ? "标记为未完成" : "标记为已完成"}
              aria-pressed={todo.status === "finished"}
              disabled={toggling}
              onClick={() => {
                void handleToggle();
              }}
            >
              <span className="todo-card__check-ring">
                <span className="todo-card__check-glyph" aria-hidden="true">
                  {todo.status === "finished" ? <Check size={14} /> : <Circle size={14} />}
                </span>
              </span>
            </button>
          </div>

          {(todo.tags ?? []).length > 0 ? (
            <EntityTagEditor
              projectId={todo.projectId}
              availableTags={availableTags}
              tags={todo.tags ?? []}
              compact
              mode={contentEditing && onUpdateTags ? "edit" : "display"}
              onChange={(tagIds) => onUpdateTags?.(todo.id, tagIds)}
            />
          ) : null}

          {visibleUnfinishedSubItems.length > 0 ? (
            <div className="todo-card__progress-stack">
              {visibleUnfinishedSubItems.map((progress) => renderProgressItem(progress, false))}
            </div>
          ) : null}

          <div className="todo-card__subitem-row">
            <TodoInlineProgressEditor
              latestProgress={null}
              editable={allowInlineProgress}
              onError={onError}
              internalReferenceContext={{ scope: "project", projectId: todo.projectId }}
              onOpenInternalReference={onOpenInternalReference}
              onOpenContactMention={onOpenContactMention}
              onEditingChange={setProgressEditing}
              onSave={(payload) => onAddProgress(todo.id, payload)}
              onUpdateLatestProgress={onUpdateProgress}
              onDeleteLatestProgress={onDeleteProgress}
            />
            <IconButton
              ref={expandButtonRef}
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                "todo-card__expand opacity-60 group-hover:opacity-100 group-focus-within:opacity-100",
                progressEditing && "todo-card__expand--hidden",
              )}
              aria-label={expanded ? "收起已完成子项" : "展开已完成子项"}
              disabled={!canExpand}
              onClick={() => onToggleExpanded(todo.id)}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </IconButton>
          </div>

          {expanded && canExpand ? (
            <div className="todo-card__finished-panel">
              <div className="grid">
                {finishedSubItems.map((progress, index) => renderProgressItem(progress, index > 0))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function TodoHistoryProgressItem({
  progress,
  projectId,
  editable,
  bordered,
  showCheckbox = false,
  visualState = null,
  onUpdateProgress,
  onToggleStatus,
  onDeleteProgress,
  onError,
  onOpenInternalReference,
  onOpenContactMention,
}: {
  progress: TodoProgressRecord;
  projectId: number;
  editable: boolean;
  bordered: boolean;
  showCheckbox?: boolean;
  visualState?: ProgressVisualState;
  onUpdateProgress: (
    progressId: number,
    payload: { content: string; progressDate: string; status?: TodoRecord["status"] },
  ) => Promise<unknown> | void;
  onToggleStatus?: (
    progressId: number,
    nextStatus: TodoRecord["status"],
  ) => Promise<unknown> | void;
  onDeleteProgress: (progressId: number) => Promise<unknown> | void;
  onError?: (message: string) => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(progress.content);
  const [saving, setSaving] = useState(false);
  const [optimisticProgress, setOptimisticProgress] = useState<TodoProgressRecord | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const displayProgress = optimisticProgress ?? progress;
  const progressContextActions: ContextMenuAction[] = [
    ...(editable
      ? [{
          icon: Pencil,
          label: "编辑子项",
          onSelect: () => {
            if (!saving) {
              setEditing(true);
            }
          },
        }]
      : []),
    {
      icon: Trash2,
      label: "删除子项",
      tone: "danger" as const,
      onSelect: () => {
        void onDeleteProgress(progress.id);
      },
    },
  ];

  useEffect(() => {
    if (!editing) {
      setDraft(displayProgress.content);
    }
  }, [displayProgress.content, editing]);

  useEffect(() => {
    if (!optimisticProgress) {
      return;
    }

    if (
      progress.content === optimisticProgress.content &&
      progress.progressDate === optimisticProgress.progressDate &&
      progress.status === optimisticProgress.status
    ) {
      setOptimisticProgress(null);
    }
  }, [optimisticProgress, progress]);

  async function handleSave() {
    if (saveInFlightRef.current) {
      return;
    }

    const normalizedDraft = normalizeProgressDraft(draft).trim();
    const currentContent = displayProgress.content.trim();
    if (!normalizedDraft || /^@\d{4}$/u.test(normalizedDraft)) {
      setEditing(false);
      return;
    }

    const parsed = parseProgressInput(normalizedDraft, new Date(), displayProgress.progressDate);
    if (!parsed.ok) {
      onError?.(parsed.error);
      return;
    }

    if (
      parsed.content === currentContent &&
      parsed.progressDate === displayProgress.progressDate
    ) {
      setEditing(false);
      return;
    }

    saveInFlightRef.current = true;
    setSaving(true);
    setOptimisticProgress({
      ...displayProgress,
      content: parsed.content,
      progressDate: parsed.progressDate,
      status: progress.status ?? "unfinished",
    });
    setEditing(false);
    try {
      await onUpdateProgress(progress.id, {
        content: parsed.content,
        progressDate: parsed.progressDate,
        status: progress.status ?? "unfinished",
      });
    } catch (error) {
      setOptimisticProgress(null);
      setEditing(true);
      throw error;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function handleToggleSubItem() {
    setStatusSaving(true);
    try {
      const nextStatus = progress.status === "finished" ? "unfinished" : "finished";
      if (onToggleStatus) {
        await onToggleStatus(progress.id, nextStatus);
      } else {
        await onUpdateProgress(progress.id, {
          content: progress.content,
          progressDate: progress.progressDate,
          status: nextStatus,
        });
      }
    } finally {
      setStatusSaving(false);
    }
  }

  if (editing) {
    return (
      <div
        className={cn(
          "todo-progress-item todo-progress-item--editing",
          bordered && "todo-progress-item--bordered",
        )}
      >
        <div className="relative todo-progress-item__editor-shell">
          <TodoProgressTextEditor
            value={draft}
            autoFocus
            disabled={saving}
            placeholder="@0315 已与财务确认方案"
            internalReferenceContext={{ scope: "project", projectId }}
            onChange={setDraft}
            onCommit={() => {
              void handleSave();
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <article
      className={cn(
        "todo-progress-item",
        bordered && "todo-progress-item--bordered",
        visualState && `todo-progress-item--${visualState}`,
      )}
      data-state={[
        displayProgress.status === "finished" ? "finished" : "unfinished",
        visualState ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      onContextMenu={(event) => {
        if (progressContextActions.length === 0 || shouldIgnoreContextMenuTarget(event.target)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="flex min-w-0 items-start gap-2">
        <p
          role={editable ? "button" : undefined}
          tabIndex={editable ? 0 : undefined}
          className={cn(
            "todo-progress-item__text min-w-0 flex-1",
            displayProgress.status === "finished" && "text-text-soft line-through",
          )}
          onClick={() => {
            if (editable && !saving) {
              setEditing(true);
            }
          }}
          onKeyDown={(event) => {
            if (!editable || saving) {
              return;
            }

            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setEditing(true);
            }
          }}
        >
          <span className="todo-progress-item__text-inner">
            <InternalReferenceInlineText
              value={displayProgress.content}
              className="break-words"
              variant="todo-inline"
              onOpenInternalReference={onOpenInternalReference}
              onOpenContactMention={onOpenContactMention}
            />
          </span>
        </p>
        {showCheckbox ? (
          <button
            type="button"
            className="todo-progress-item__check mt-0.5"
            aria-label={
              displayProgress.status === "finished" ? "标记子项未完成" : "标记子项完成"
            }
            aria-pressed={displayProgress.status === "finished"}
            disabled={statusSaving || saving}
            onClick={() => {
              void handleToggleSubItem();
            }}
          >
            <span className="todo-progress-item__check-ring">
              <span className="todo-progress-item__check-glyph" aria-hidden="true">
                {displayProgress.status === "finished" ? <Check size={11} /> : <Circle size={10} />}
              </span>
            </span>
          </button>
        ) : null}
      </div>
      {contextMenu ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Todo 子项操作"
          onClose={() => setContextMenu(null)}
          actions={progressContextActions}
        />
      ) : null}
    </article>
  );
}

function normalizeProgressDraft(value: string) {
  return value.replace(/\r?\n+/gu, " ");
}
