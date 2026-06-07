import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Check, Circle, Pencil, Trash2 } from "lucide-react";

import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
  findInternalReferenceTextTrigger,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import type { ContactMentionTarget } from "../../lib/contactMentions";
import type {
  FileTagRecord,
  InternalReferenceSearchResult,
  TodoPriority,
  TodoProgressRecord,
  TodoRecord,
} from "../../lib/types";
import { ActionContextMenu, IconButton } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  InternalReferenceInlineText,
  InternalReferencePicker,
  useInternalReferenceSearch,
} from "../internal-reference";
import { TodoInlineContentEditor } from "./TodoInlineContentEditor";
import { TodoInlineProgressEditor } from "./TodoInlineProgressEditor";
import { TodoPriorityDropdown } from "./TodoPriorityDropdown";
import { TodoReferenceEditor } from "./TodoReferenceEditor";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import {
  formatFullDate,
  formatMonthDay,
  parseProgressInput,
  sortTodoProgresses,
} from "./todo-utils";

export function TodoListItem({
  todo,
  isFirst = false,
  compact = false,
  allowInlineEdit = false,
  allowInlineProgress = false,
  expanded = false,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onUpdateTags,
  onAddProgress,
  onUpdateProgress,
  onDeleteProgress,
  onOpenTodoSource,
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
  onOpenTodoSource: (todo: TodoRecord) => void;
  onToggleExpanded: (todoId: number, nextExpanded?: boolean) => void;
  onOpenContextMenu: (todoId: number, x: number, y: number) => void;
  onError?: (message: string) => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
  availableTags?: FileTagRecord[];
}) {
  const [toggling, setToggling] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const sortedProgresses = sortTodoProgresses(todo.progresses);
  const unfinishedSubItems = sortedProgresses.filter(
    (progress) => progress.status !== "finished",
  );
  const finishedSubItems = sortedProgresses.filter(
    (progress) => progress.status === "finished",
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

  async function handleToggle() {
    setToggling(true);
    try {
      await onToggleStatus(todo.id, todo.status === "finished" ? "unfinished" : "finished");
    } finally {
      setToggling(false);
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
          internalReferenceContext={{ scope: "project", projectId: todo.projectId }}
          onOpenInternalReference={onOpenInternalReference}
          onOpenContactMention={onOpenContactMention}
          onSave={(content) => onUpdateContent(todo.id, content)}
        />

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption leading-4">
          <TodoPriorityDropdown
            priority={todo.priority}
            onSelect={(priority) => onUpdatePriority(todo.id, priority)}
          />
          <span className="text-text-soft">·</span>
          <button
            type="button"
            className="max-w-full truncate bg-transparent text-text-soft transition-colors hover:text-text"
            onClick={() => onOpenTodoSource(todo)}
          >
            项目级
          </button>
        </div>

        {(todo.tags ?? []).length > 0 || onUpdateTags ? (
          <EntityTagEditor
            projectId={todo.projectId}
            availableTags={availableTags}
            tags={todo.tags ?? []}
            compact
            onChange={(tagIds) => onUpdateTags?.(todo.id, tagIds)}
          />
        ) : null}

        {unfinishedSubItems.length > 0 ? (
          <div className="grid gap-1.5">
            {unfinishedSubItems.map((progress) => (
              <TodoHistoryProgressItem
                key={progress.id}
                progress={progress}
                projectId={todo.projectId}
                editable={allowInlineProgress}
                bordered={false}
                showCheckbox
                onUpdateProgress={onUpdateProgress}
                onDeleteProgress={onDeleteProgress}
                onError={onError}
                onOpenInternalReference={onOpenInternalReference}
                onOpenContactMention={onOpenContactMention}
              />
            ))}
          </div>
        ) : null}

        <TodoInlineProgressEditor
          latestProgress={null}
          editable={allowInlineProgress}
          onError={onError}
          internalReferenceContext={{ scope: "project", projectId: todo.projectId }}
          onOpenInternalReference={onOpenInternalReference}
          onOpenContactMention={onOpenContactMention}
          onSave={(payload) => onAddProgress(todo.id, payload)}
          onUpdateLatestProgress={onUpdateProgress}
          onDeleteLatestProgress={onDeleteProgress}
        />

        {expanded && canExpand ? (
          <div className="mt-1 border-t border-border">
            <div className="grid">
              {finishedSubItems.map((progress, index) => (
                <TodoHistoryProgressItem
                  key={progress.id}
                  progress={progress}
                  projectId={todo.projectId}
                  editable={allowInlineProgress}
                  bordered={index > 0}
                  showCheckbox
                  onUpdateProgress={onUpdateProgress}
                  onDeleteProgress={onDeleteProgress}
                  onError={onError}
                  onOpenInternalReference={onOpenInternalReference}
                  onOpenContactMention={onOpenContactMention}
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
          aria-label={expanded ? "收起已完成子项" : "展开已完成子项"}
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
  projectId,
  editable,
  bordered,
  showCheckbox = false,
  onUpdateProgress,
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
  onUpdateProgress: (
    progressId: number,
    payload: { content: string; progressDate: string; status?: TodoRecord["status"] },
  ) => Promise<unknown> | void;
  onDeleteProgress: (progressId: number) => Promise<unknown> | void;
  onError?: (message: string) => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(progress.content);
  const [saving, setSaving] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [referenceActiveIndex, setReferenceActiveIndex] = useState(0);
  const [dismissedTriggerKey, setDismissedTriggerKey] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const saveInFlightRef = useRef(false);
  const skipBlurSaveRef = useRef(false);
  const referenceTrigger = editing
    ? findInternalReferenceTextTrigger(draft, selectionStart)
    : null;
  const referenceTriggerKey = referenceTrigger
    ? `${referenceTrigger.start}:${referenceTrigger.end}:${referenceTrigger.query}`
    : null;
  const referencePickerOpen =
    Boolean(referenceTrigger) && dismissedTriggerKey !== referenceTriggerKey;
  const { results: referenceResults, loading: referenceLoading } = useInternalReferenceSearch({
    open: referencePickerOpen,
    query: referenceTrigger?.query ?? "",
    context: { scope: "project", projectId },
    limit: 8,
  });

  useEffect(() => {
    if (!editing) {
      setDraft(progress.content);
      setSelectionStart(null);
      setDismissedTriggerKey(null);
    }
  }, [editing, progress.content]);

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
        status: progress.status ?? "unfinished",
      });
      setEditing(false);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function handleToggleSubItem() {
    setStatusSaving(true);
    try {
      await onUpdateProgress(progress.id, {
        content: progress.content,
        progressDate: progress.progressDate,
        status: progress.status === "finished" ? "unfinished" : "finished",
      });
    } finally {
      setStatusSaving(false);
    }
  }

  function handleReferenceInsert(reference: InternalReferenceSearchResult) {
    if (!referenceTrigger) {
      return;
    }

    const target = buildInternalReferenceTarget(reference);
    const token = `${buildInternalReferenceToken(target)} `;
    const nextDraft =
      draft.slice(0, referenceTrigger.start) + token + draft.slice(referenceTrigger.end);
    const nextSelection = referenceTrigger.start + token.length;

    setDraft(nextDraft);
    setSelectionStart(nextSelection);
    setDismissedTriggerKey(null);

    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }

  if (editing) {
    return (
      <div className={cn("grid gap-2 py-2", bordered && "border-t border-border")}>
        <div className="relative">
          <TodoReferenceEditor
            editorRef={editorRef}
            value={draft}
            selectionOffset={selectionStart}
            autoFocus
            disabled={saving}
            placeholder="@0315 已与财务确认方案"
            textClassName="text-ui leading-5"
            onChange={(nextValue, nextSelection) => {
              setDraft(normalizeProgressDraft(nextValue));
              setSelectionStart(nextSelection);
            }}
            onSelectionChange={setSelectionStart}
            onBlur={() => {
              if (skipBlurSaveRef.current) {
                skipBlurSaveRef.current = false;
                return;
              }
              void handleSave();
            }}
            onKeyDown={(event) => {
              if (referencePickerOpen) {
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
                  handleReferenceInsert(referenceResults[referenceActiveIndex] ?? referenceResults[0]);
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
          <InternalReferencePicker
            open={referencePickerOpen}
            loading={referenceLoading}
            results={referenceResults}
            activeIndex={referenceActiveIndex}
            className="absolute left-0 top-[calc(100%+6px)] z-20 w-[22rem]"
            onHoverIndex={setReferenceActiveIndex}
            onSelect={handleReferenceInsert}
          />
        </div>
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
      <div className="flex min-w-0 items-start gap-2">
        {showCheckbox ? (
          <button
            type="button"
            className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-bg text-text-soft transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong hover:text-text"
            aria-label={
              progress.status === "finished" ? "标记子项未完成" : "标记子项完成"
            }
            disabled={statusSaving}
            onClick={() => {
              void handleToggleSubItem();
            }}
          >
            {progress.status === "finished" ? <Check size={11} /> : null}
          </button>
        ) : null}
        <p
          className={cn(
            "min-w-0 flex-1 text-ui leading-5 text-text-muted",
            progress.status === "finished" && "text-text-soft line-through",
          )}
        >
          <InternalReferenceInlineText
            value={progress.content}
            className="break-words"
            variant="todo-inline"
            onOpenInternalReference={onOpenInternalReference}
            onOpenContactMention={onOpenContactMention}
          />
          <span
            className="ml-2 text-caption text-text-soft"
            title={formatFullDate(progress.progressDate)}
          >
            {formatMonthDay(progress.progressDate)}
          </span>
        </p>
      </div>
      {contextMenu ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Todo 子项操作"
          onClose={() => setContextMenu(null)}
          actions={[
            {
              icon: Pencil,
              label: "编辑子项",
              onSelect: () => {
                setEditing(true);
              },
            },
            {
              icon: Trash2,
              label: "删除子项",
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
