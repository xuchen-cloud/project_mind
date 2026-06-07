import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ListTodo, Plus } from "lucide-react";

import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
  findInternalReferenceTextTrigger,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import {
  buildContactMentionTarget,
  buildContactMentionToken,
  findContactMentionTextTrigger,
  type ContactMentionTarget,
} from "../../lib/contactMentions";
import type {
  ContactRecord,
  InternalReferenceSearchResult,
  TodoPriority,
  TodoRecord,
} from "../../lib/types";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useUiStore } from "../../state/ui-store";
import { Button, IconButton, SurfaceCard } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { projectMindApi } from "../../services/projectMindApi";
import { ContactMentionPicker, useContactMentionSearch } from "../contact";
import { InternalReferencePicker, useInternalReferenceSearch } from "../internal-reference";
import { TodoList } from "./TodoList";
import { TodoSortSwitch } from "./TodoSortSwitch";
import {
  priorityColorValue,
  sortTodos,
  TODO_PRIORITY_OPTIONS,
  type TodoSortMode,
} from "./todo-utils";
import {
  clearTodoComposerDraft,
  readTodoComposerDraft,
  writeTodoComposerDraft,
  type TodoComposerDraftSnapshot,
} from "./todo-draft-storage";

interface TodoRailProps {
  projectId?: number;
  title: string;
  scopeLabel: string;
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
  createPlaceholder: string;
  onCreateTodo: (payload: { content: string; priority: TodoPriority }) => void;
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
  onDeleteTodo: (todoId: number) => Promise<unknown> | void;
  onOpenTodoSource: (todo: TodoRecord) => void;
  onError?: (message: string) => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
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
  projectId,
  title,
  scopeLabel,
  unfinishedTodos,
  finishedTodos,
  createPlaceholder,
  onCreateTodo,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onUpdateTags,
  onAddProgress,
  onUpdateProgress,
  onDeleteProgress,
  onDeleteTodo,
  onOpenTodoSource,
  onError,
  onOpenInternalReference,
  onOpenContactMention,
}: TodoRailProps) {
  const {
    todoRailCollapsed,
    todoRailWidthPx,
    setTodoRailCollapsed,
    setTodoRailWidthPx,
    toggleTodoRailCollapsed,
  } = useUiStore();
  const draftStorageKey = buildTodoRailDraftStorageKey(projectId);
  const initialComposerDraft = readTodoComposerDraft(draftStorageKey);
  const [tab, setTab] = useState<"unfinished" | "finished">("unfinished");
  const [sortMode, setSortMode] = useState<TodoSortMode>("time");
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | null>(null);
  const [tagFilterId, setTagFilterId] = useState<number | null>(null);
  const [isComposing, setIsComposing] = useState(
    () => Boolean(initialComposerDraft?.content.trim()),
  );
  const [content, setContent] = useState(
    () => initialComposerDraft?.content ?? "",
  );
  const [priority, setPriority] = useState<TodoPriority>(
    () => initialComposerDraft?.priority ?? "not_urgent_important",
  );
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(() => new Set());
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [referenceActiveIndex, setReferenceActiveIndex] = useState(0);
  const [dismissedTriggerKey, setDismissedTriggerKey] = useState<string | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerDraftRef = useRef<{
    key: string;
    snapshot: TodoComposerDraftSnapshot;
  }>({
    key: draftStorageKey,
    snapshot: {
      content: initialComposerDraft?.content ?? "",
      priority: initialComposerDraft?.priority ?? "not_urgent_important",
    },
  });
  const referenceTrigger = isComposing ? findInternalReferenceTextTrigger(content, selectionStart) : null;
  const referenceTriggerKey = referenceTrigger
    ? `${referenceTrigger.start}:${referenceTrigger.end}:${referenceTrigger.query}`
    : null;
  const referencePickerOpen =
    Boolean(referenceTrigger) && dismissedTriggerKey !== referenceTriggerKey;
  const { results: referenceResults, loading: referenceLoading } = useInternalReferenceSearch({
    open: referencePickerOpen,
    query: referenceTrigger?.query ?? "",
    context:
      projectId === undefined
        ? null
        : { scope: "project", projectId },
    limit: 8,
  });

  const contactMentionOptions = useContactMentionOptions();
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const mentionTrigger = isComposing
    ? findContactMentionTextTrigger(content, selectionStart)
    : null;
  const mentionTriggerKey = mentionTrigger
    ? `${mentionTrigger.start}:${mentionTrigger.end}:${mentionTrigger.query}`
    : null;
  const mentionPickerOpen =
    Boolean(mentionTrigger) && dismissedMentionKey !== mentionTriggerKey;
  const { results: mentionResults, loading: mentionLoading } = useContactMentionSearch({
    open: mentionPickerOpen,
    query: mentionTrigger?.query ?? "",
    limit: 8,
  });
  const mentionCreateName = mentionTrigger?.query.trim() ?? "";
  const mentionCreatable = mentionPickerOpen && mentionCreateName.length > 0;
  const mentionOptionCount = mentionResults.length + (mentionCreatable ? 1 : 0);
  const tagSettingsQuery = useQuery({
    queryKey: ["file-tag-settings", projectId],
    queryFn: projectMindApi.fileTagSettingsGet,
    enabled: projectId !== undefined,
  });
  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const todoTagOptions = useMemo(() => {
    const countById = new Map<number, number>();
    const metaById = new Map<number, NonNullable<TodoRecord["tags"]>[number]>();
    for (const todo of [...unfinishedTodos, ...finishedTodos]) {
      for (const tag of todo.tags ?? []) {
        metaById.set(tag.id, tag);
        countById.set(tag.id, (countById.get(tag.id) ?? 0) + 1);
      }
    }
    return Array.from(metaById.values())
      .map((tag) => ({ ...tag, count: countById.get(tag.id) ?? 0 }))
      .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
  }, [finishedTodos, unfinishedTodos]);

  const tabTodos = tab === "unfinished" ? unfinishedTodos : finishedTodos;
  const todos = useMemo(() => {
    const filteredTodos =
      priorityFilter === null
        ? tabTodos
        : tabTodos.filter((todo) => todo.priority === priorityFilter);
    const tagFilteredTodos =
      tagFilterId === null
        ? filteredTodos
        : filteredTodos.filter((todo) => (todo.tags ?? []).some((tag) => tag.id === tagFilterId));
    return sortTodos(tagFilteredTodos, sortMode);
  }, [priorityFilter, sortMode, tabTodos, tagFilterId]);
  const showSortSwitch = todos.length > 1;
  const summaryText = useMemo(
    () => `${unfinishedTodos.length} 未完成 · ${finishedTodos.length} 已完成`,
    [finishedTodos.length, unfinishedTodos.length],
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

  useEffect(() => {
    if (!mentionPickerOpen) {
      setMentionActiveIndex(0);
      return;
    }

    setMentionActiveIndex((current) => {
      if (mentionOptionCount === 0) {
        return 0;
      }

      return Math.min(current, mentionOptionCount - 1);
    });
  }, [mentionPickerOpen, mentionOptionCount]);

  useEffect(() => {
    if (!mentionPickerOpen) {
      return;
    }

    setMentionActiveIndex(0);
  }, [mentionPickerOpen, mentionTrigger?.query]);

  useEffect(() => {
    if (isComposing) {
      return;
    }

    setSelectionStart(null);
    setDismissedTriggerKey(null);
    setDismissedMentionKey(null);
  }, [isComposing]);

  useEffect(() => {
    const snapshot = readTodoComposerDraft(draftStorageKey);
    setContent(snapshot?.content ?? "");
    setPriority(snapshot?.priority ?? "not_urgent_important");
    setIsComposing(Boolean(snapshot?.content.trim()));
    setSelectionStart(null);
    setDismissedTriggerKey(null);
  }, [draftStorageKey]);

  useEffect(() => {
    const snapshot = { content, priority };
    composerDraftRef.current = { key: draftStorageKey, snapshot };
    writeTodoComposerDraft(draftStorageKey, snapshot);
  }, [content, draftStorageKey, priority]);

  useEffect(() => {
    const flushDraft = () => {
      const { key, snapshot } = composerDraftRef.current;
      writeTodoComposerDraft(key, snapshot);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushDraft();
      }
    };

    window.addEventListener("blur", flushDraft);
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("blur", flushDraft);
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const nextWidth = window.innerWidth - event.clientX;
      setTodoRailWidthPx(nextWidth);
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [setTodoRailWidthPx]);

  function submitCreate() {
    if (!content.trim()) {
      return;
    }
    onCreateTodo({ content: content.trim(), priority });
    clearTodoComposerDraft(draftStorageKey);
    setContent("");
    setPriority("not_urgent_important");
    setIsComposing(false);
    setSelectionStart(null);
    setDismissedTriggerKey(null);
  }

  function handleReferenceInsert(reference: InternalReferenceSearchResult) {
    if (!referenceTrigger) {
      return;
    }

    const target = buildInternalReferenceTarget(reference);
    const token = `${buildInternalReferenceToken(target)} `;
    const nextContent =
      content.slice(0, referenceTrigger.start) + token + content.slice(referenceTrigger.end);
    const nextSelection = referenceTrigger.start + token.length;

    setContent(nextContent);
    setSelectionStart(nextSelection);
    setDismissedTriggerKey(null);

    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
      composerInputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  }

  function insertMentionToken(token: string, trigger: { start: number; end: number }) {
    const insertText = `${token} `;
    const nextContent =
      content.slice(0, trigger.start) + insertText + content.slice(trigger.end);
    const nextSelection = trigger.start + insertText.length;

    setContent(nextContent);
    setSelectionStart(nextSelection);
    setDismissedMentionKey(null);

    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
      composerInputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  }

  function handleMentionInsert(contact: ContactRecord) {
    if (!mentionTrigger) {
      return;
    }

    const token = buildContactMentionToken(buildContactMentionTarget(contact));
    insertMentionToken(token, mentionTrigger);
  }

  function handleMentionCreate(name: string) {
    if (!mentionTrigger || !contactMentionOptions.onCreateContact || !name.trim()) {
      return;
    }

    const trigger = mentionTrigger;
    void Promise.resolve(contactMentionOptions.onCreateContact(name.trim())).then((target) => {
      if (target) {
        insertMentionToken(buildContactMentionToken(target), trigger);
      }
    });
    setDismissedMentionKey(mentionTriggerKey);
  }

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

  if (todoRailCollapsed) {
    return (
      <aside
        className="flex w-12 shrink-0 flex-col items-center gap-3 border-l border-border bg-bg-subtle px-1.5 py-3 transition-[width] duration-[160ms] ease-[var(--ease-soft)]"
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
      className="relative flex shrink-0 flex-col border-l border-border bg-bg-subtle transition-[width] duration-[160ms] ease-[var(--ease-soft)]"
      style={{ width: `${todoRailWidthPx}px` }}
      aria-label={`${title} 侧边栏`}
    >
      <div
        className="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize"
        aria-hidden="true"
        onPointerDown={(event) => {
          event.preventDefault();
          const handlePointerMove = (moveEvent: PointerEvent) => {
            const nextWidth = window.innerWidth - moveEvent.clientX;
            setTodoRailWidthPx(nextWidth);
          };
          const handlePointerUp = () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
          };
          window.addEventListener("pointermove", handlePointerMove);
          window.addEventListener("pointerup", handlePointerUp);
        }}
      />
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

        {todoTagOptions.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-1">
            <button
              type="button"
              className={cn(
                "rounded-[var(--radius-6)] border px-2 py-1 text-caption transition-colors",
                tagFilterId === null
                  ? "border-border-strong bg-bg text-text"
                  : "border-transparent text-text-soft hover:border-border hover:bg-bg-hover hover:text-text",
              )}
              onClick={() => setTagFilterId(null)}
            >
              全部标签
            </button>
            {todoTagOptions.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={cn(
                  "rounded-[var(--radius-6)] border px-2 py-1 text-caption transition-colors",
                  tagFilterId === tag.id
                    ? "border-border-strong bg-bg text-text"
                    : "border-transparent text-text-soft hover:border-border hover:bg-bg-hover hover:text-text",
                )}
                onClick={() => setTagFilterId((current) => (current === tag.id ? null : tag.id))}
              >
                {tag.label} {tag.count}
              </button>
            ))}
          </div>
        ) : null}

        {isComposing ? (
          <SurfaceCard className="mb-3 grid gap-2 p-3">
            <div className="relative">
              <textarea
                ref={composerInputRef}
                rows={3}
                className="min-h-[5.5rem] w-full resize-y rounded-[var(--radius-6)] border border-border bg-bg px-3 py-2 text-body text-text outline-none transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] placeholder:text-text-soft hover:border-border-strong focus:border-accent"
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setSelectionStart(event.target.selectionStart);
                }}
                onClick={(event) => setSelectionStart(event.currentTarget.selectionStart)}
                onKeyUp={(event) => setSelectionStart(event.currentTarget.selectionStart)}
                onSelect={(event) => setSelectionStart(event.currentTarget.selectionStart)}
                onKeyDown={(event) => {
                  if (mentionPickerOpen) {
                    if (event.key === "ArrowDown" && mentionOptionCount > 0) {
                      event.preventDefault();
                      setMentionActiveIndex((current) => (current + 1) % mentionOptionCount);
                      return;
                    }

                    if (event.key === "ArrowUp" && mentionOptionCount > 0) {
                      event.preventDefault();
                      setMentionActiveIndex((current) =>
                        current === 0 ? mentionOptionCount - 1 : current - 1,
                      );
                      return;
                    }

                    if (event.key === "Enter" && mentionOptionCount > 0) {
                      event.preventDefault();
                      if (mentionCreatable && mentionActiveIndex === mentionResults.length) {
                        handleMentionCreate(mentionCreateName);
                      } else {
                        handleMentionInsert(
                          mentionResults[mentionActiveIndex] ?? mentionResults[0],
                        );
                      }
                      return;
                    }

                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDismissedMentionKey(mentionTriggerKey);
                      return;
                    }
                  }

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

                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    submitCreate();
                  }
                }}
                placeholder={createPlaceholder}
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
              <ContactMentionPicker
                open={mentionPickerOpen}
                loading={mentionLoading}
                results={mentionResults}
                activeIndex={mentionActiveIndex}
                query={mentionTrigger?.query ?? ""}
                canCreate={mentionCreatable}
                className="absolute left-0 top-[calc(100%+6px)] z-20"
                onHoverIndex={setMentionActiveIndex}
                onSelect={handleMentionInsert}
                onCreate={handleMentionCreate}
              />
            </div>
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
            compact
            allowInlineEdit={tab === "unfinished"}
            allowInlineProgress={tab === "unfinished"}
            expandedTodoIds={expandedTodoIds}
            onToggleExpanded={toggleExpanded}
            emptyText={tab === "unfinished" ? "当前没有未完成 Todo。" : "当前没有已完成 Todo。"}
            onToggleStatus={onToggleStatus}
            onUpdatePriority={onUpdatePriority}
            onUpdateContent={onUpdateContent}
            onUpdateTags={onUpdateTags}
            onAddProgress={onAddProgress}
            onUpdateProgress={onUpdateProgress}
            onDeleteProgress={onDeleteProgress}
            onDeleteTodo={onDeleteTodo}
            onOpenTodoSource={onOpenTodoSource}
            onError={onError}
            onOpenInternalReference={onOpenInternalReference}
            onOpenContactMention={onOpenContactMention}
            availableTags={availableTags}
            onEmptyClick={
              tab === "unfinished"
                ? () => {
                    setIsComposing(true);
                  }
                : undefined
            }
          />
        </div>
      </div>
    </aside>
  );
}

function buildTodoRailDraftStorageKey(projectId: number | undefined) {
  return `project-mind:todo-rail-draft:${projectId ?? "workspace"}`;
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
