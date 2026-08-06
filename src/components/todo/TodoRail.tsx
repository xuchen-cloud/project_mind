import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ListTodo, Plus, RefreshCw } from "lucide-react";

import { type InternalReferenceTarget } from "../../lib/internalReferences";
import { type ContactMentionTarget } from "../../lib/contactMentions";
import type {
  ProjectTagRecord,
  TodoPriority,
  TodoRecord,
  TodoTagUpdateHandler,
} from "../../lib/types";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { deriveContactPinyin } from "../../lib/pinyin";
import { useUiStore } from "../../state/ui-store";
import { Button, IconButton } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { ContactMentionPicker, useContactMentionSearch } from "../contact";
import { InternalReferencePicker, useInternalReferenceSearch } from "../internal-reference";
import { TagMentionPicker, useTagMentionSearch } from "../tags/TagMentionPicker";
import { TodoList } from "./TodoList";
import { TodoSortSwitch } from "./TodoSortSwitch";
import { parseDueDateInput, priorityColorValue, sortTodos, TODO_PRIORITY_OPTIONS } from "./todo-utils";
import {
  buildTodoComposerDraftStorageKey,
  clearTodoComposerDraft,
  readTodoComposerDraft,
  writeTodoComposerDraft,
  type TodoComposerDraftSnapshot,
} from "./todo-draft-storage";
import {
  focusTodoEditorInput,
  getTodoEditorPickerPosition,
  handleTodoEditorMentionKeyDown,
  handleTodoEditorReferenceKeyDown,
  handleTodoEditorTagKeyDown,
  insertInternalReferenceToken,
  insertMentionToken,
  insertTagToken,
  resetTodoEditorControllerState,
  useSyncTodoEditorPickerState,
  useTodoEditorController,
} from "./todo-editor-controller";

interface TodoRailProps {
  projectId?: number;
  focusTodoId?: number | null;
  title: string;
  scopeLabel: string;
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
  availableTags?: ProjectTagRecord[];
  canCreateTagsForTodo?: (todo: TodoRecord) => boolean;
  showTodoSources?: boolean;
  viewMode?: "workspace" | "current-project";
  showViewModeSwitch?: boolean;
  canCreateTodo?: boolean;
  onViewModeChange?: (mode: "workspace" | "current-project") => void;
  onOpenProject?: (projectId: number) => Promise<unknown> | void;
  createPlaceholder: string;
  createOwnershipOptions?: Array<{ projectId: number; name: string }>;
  onCreateTodo: (payload: {
    content: string;
    priority: TodoPriority;
    dueDate?: string | null;
    projectId?: number | null;
  }) => Promise<unknown> | void;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string, dueDate?: string | null) => Promise<unknown> | void;
  onUpdateTags?: TodoTagUpdateHandler;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string; dueDate?: string | null },
  ) => Promise<unknown> | void;
  onUpdateProgress: (
    progressId: number,
    payload: { content: string; progressDate: string; dueDate?: string | null; status?: TodoRecord["status"] },
  ) => Promise<unknown> | void;
  onDeleteProgress: (progressId: number) => Promise<unknown> | void;
  onDeleteTodo: (todoId: number) => Promise<unknown> | void;
  onRefresh?: () => Promise<unknown> | void;
  refreshing?: boolean;
  onError?: (message: string) => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
}

export function TodoRail({
  projectId,
  focusTodoId = null,
  title,
  scopeLabel: _scopeLabel,
  unfinishedTodos,
  finishedTodos,
  availableTags = [],
  canCreateTagsForTodo,
  showTodoSources = false,
  viewMode,
  showViewModeSwitch = false,
  canCreateTodo = true,
  onViewModeChange,
  onOpenProject,
  createPlaceholder,
  createOwnershipOptions,
  onCreateTodo,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onUpdateTags,
  onAddProgress,
  onUpdateProgress,
  onDeleteProgress,
  onDeleteTodo,
  onRefresh,
  refreshing = false,
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
    todoRailTab: tab,
    setTodoRailTab: setTab,
    todoRailSortMode: sortMode,
    setTodoRailSortMode: setSortMode,
    todoRailDisplayMode: displayMode,
    setTodoRailDisplayMode: setDisplayMode,
  } = useUiStore();
  const draftStorageKey = buildTodoComposerDraftStorageKey(projectId);
  const railRef = useRef<HTMLElement | null>(null);
  const initialComposerDraft = readTodoComposerDraft(draftStorageKey);
  const internalReferenceContext =
    projectId === undefined
      ? { scope: "workspace" as const, projectId: null }
      : { scope: "project" as const, projectId };
  const [isComposing, setIsComposing] = useState(
    () => Boolean(initialComposerDraft?.content.trim()),
  );
  const [content, setContent] = useState(
    () => initialComposerDraft?.content ?? "",
  );
  const [priority, setPriority] = useState<TodoPriority>(
    () => initialComposerDraft?.priority ?? "not_urgent_important",
  );
  const [createProjectId, setCreateProjectId] = useState<number | null>(
    () => initialComposerDraft?.projectId ?? null,
  );
  const [ownershipPickerOpen, setOwnershipPickerOpen] = useState(false);
  const [ownershipQuery, setOwnershipQuery] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const composerInternalReferenceContext =
    createOwnershipOptions && createProjectId !== null
      ? { scope: "project" as const, projectId: createProjectId }
      : internalReferenceContext;
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(() => new Set());
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerDraftRef = useRef<{
    key: string;
    snapshot: TodoComposerDraftSnapshot;
  }>({
    key: draftStorageKey,
    snapshot: {
      content: initialComposerDraft?.content ?? "",
      priority: initialComposerDraft?.priority ?? "not_urgent_important",
      projectId: initialComposerDraft?.projectId ?? null,
    },
  });
  const contactMentionOptions = useContactMentionOptions();
  const controller = useTodoEditorController({
    draft: content,
    editing: isComposing,
    internalReferenceContext: composerInternalReferenceContext,
    canCreateMentions: Boolean(contactMentionOptions.onCreateContact),
  });
  const { results: referenceResults, loading: referenceLoading } = useInternalReferenceSearch({
    open: controller.referencePickerOpen,
    query: controller.referenceTrigger?.query ?? "",
    context: composerInternalReferenceContext,
    limit: 8,
  });
  const { results: mentionResults, loading: mentionLoading } = useContactMentionSearch({
    open: controller.mentionPickerOpen,
    query: controller.mentionTrigger?.query ?? "",
    limit: 8,
  });
  const mentionOptionCount = mentionResults.length + (controller.mentionCreatable ? 1 : 0);
  const { results: tagResults, loading: tagLoading } = useTagMentionSearch({
    open: controller.tagPickerOpen,
    query: controller.tagTrigger?.query ?? "",
    projectId: createOwnershipOptions ? createProjectId : projectId,
    limit: 8,
  });
  const tabTodos = tab === "unfinished" ? unfinishedTodos : finishedTodos;
  const todos = useMemo(() => {
    return sortTodos(tabTodos, sortMode);
  }, [sortMode, tabTodos]);
  const workspaceView = viewMode === "workspace";
  const selectedOwnershipName =
    createProjectId === null
      ? "Workspace"
      : createOwnershipOptions?.find((option) => option.projectId === createProjectId)?.name ??
        "Project 已不可用";
  const ownershipUnavailable = Boolean(
    createOwnershipOptions &&
      createProjectId !== null &&
      !createOwnershipOptions.some((option) => option.projectId === createProjectId),
  );
  const filteredOwnershipOptions = useMemo(() => {
    const normalizedQuery = ownershipQuery.trim().toLowerCase();
    if (!normalizedQuery) return createOwnershipOptions ?? [];
    return (createOwnershipOptions ?? []).filter((option) => {
      const pinyin = deriveContactPinyin(option.name);
      return (
        option.name.toLowerCase().includes(normalizedQuery) ||
        pinyin.pinyinFull.includes(normalizedQuery) ||
        pinyin.pinyinAbbr.includes(normalizedQuery)
      );
    });
  }, [createOwnershipOptions, ownershipQuery]);
  const todoGroups = useMemo(() => {
    if (!workspaceView || displayMode !== "grouped") return [];
    const groups: Array<{ key: string; title: string; todos: TodoRecord[] }> = [];
    const workspaceTodos = todos.filter((todo) => todo.scope === "workspace");
    if (workspaceTodos.length > 0) {
      groups.push({ key: "workspace", title: "Workspace", todos: workspaceTodos });
    }
    for (const project of createOwnershipOptions ?? []) {
      const projectTodos = todos.filter(
        (todo) => todo.scope === "project" && todo.projectId === project.projectId,
      );
      if (projectTodos.length > 0) {
        groups.push({ key: `project:${project.projectId}`, title: project.name, todos: projectTodos });
      }
    }
    return groups;
  }, [createOwnershipOptions, displayMode, todos, workspaceView]);
  const showSortSwitch = todos.length > 1;

  useEffect(() => {
    if (focusTodoId === null) {
      return;
    }

    const focusedTodo =
      unfinishedTodos.find((todo) => todo.id === focusTodoId) ??
      finishedTodos.find((todo) => todo.id === focusTodoId);
    if (!focusedTodo) {
      return;
    }

    setTodoRailCollapsed(false);
    setTab(focusedTodo.status === "finished" ? "finished" : "unfinished");
    const frameId = window.requestAnimationFrame(() => {
      railRef.current
        ?.querySelector<HTMLElement>(`[data-todo-id="${focusTodoId}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    finishedTodos,
    focusTodoId,
    setTab,
    setTodoRailCollapsed,
    unfinishedTodos,
  ]);

  useSyncTodoEditorPickerState({
    referencePickerOpen: controller.referencePickerOpen,
    referenceQuery: controller.referenceTrigger?.query,
    referenceResultCount: referenceResults.length,
    mentionPickerOpen: controller.mentionPickerOpen,
    mentionQuery: controller.mentionTrigger?.query,
    mentionOptionCount,
    tagPickerOpen: controller.tagPickerOpen,
    tagQuery: controller.tagTrigger?.query,
    tagResultCount: tagResults.length,
    setControllerState: controller.setControllerState,
  });

  useEffect(() => {
    if (isComposing) {
      return;
    }

    controller.setControllerState((current) => ({
      ...current,
      ...resetTodoEditorControllerState(),
    }));
  }, [controller.setControllerState, isComposing]);

  useEffect(() => {
    const snapshot = readTodoComposerDraft(draftStorageKey);
    setContent(snapshot?.content ?? "");
    setPriority(snapshot?.priority ?? "not_urgent_important");
    setCreateProjectId(snapshot?.projectId ?? null);
    setIsComposing(Boolean(snapshot?.content.trim()));
    controller.setControllerState((current) => ({
      ...current,
      ...resetTodoEditorControllerState(),
    }));
  }, [controller.setControllerState, draftStorageKey]);

  useEffect(() => {
    const snapshot = { content, priority, projectId: createProjectId };
    composerDraftRef.current = { key: draftStorageKey, snapshot };
    writeTodoComposerDraft(draftStorageKey, snapshot);
  }, [content, createProjectId, draftStorageKey, priority]);

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

  async function submitCreate() {
    if (!canCreateTodo) {
      onError?.("当前 Project 已归档，无法新建 Todo。");
      return;
    }
    if (!content.trim()) {
      return;
    }
    if (
      ownershipUnavailable
    ) {
      onError?.("所选 Project 已不可用，请重新选择归属。");
      return;
    }
    const parsed = parseDueDateInput(content);
    if (!parsed.ok) {
      onError?.(parsed.error);
      return;
    }
    setCreatePending(true);
    try {
      await onCreateTodo({
        content: parsed.content,
        priority,
        ...(createOwnershipOptions ? { projectId: createProjectId } : {}),
        ...(parsed.dueDate ? { dueDate: parsed.dueDate } : {}),
      });
      clearTodoComposerDraft(draftStorageKey);
      setContent("");
      setPriority("not_urgent_important");
      if (createOwnershipOptions) {
        setCreateProjectId(null);
      }
      setIsComposing(false);
      controller.setControllerState((current) => ({
        ...current,
        ...resetTodoEditorControllerState(),
      }));
    } catch (error) {
      onError?.(String(error));
    } finally {
      setCreatePending(false);
    }
  }

  function handleReferenceInsert(reference: Parameters<typeof insertInternalReferenceToken>[2]) {
    if (!controller.referenceTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertInternalReferenceToken(
      content,
      controller.referenceTrigger,
      reference,
    );
    setContent(nextValue);
    controller.setControllerState((current) => ({
      ...current,
      selectionStart: nextSelection,
      dismissedTriggerKey: null,
    }));
    focusTodoEditorInput(composerInputRef.current, nextSelection);
  }

  function handleMentionInsert(contact: Parameters<typeof insertMentionToken>[2]) {
    if (!controller.mentionTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertMentionToken(
      content,
      controller.mentionTrigger,
      contact,
    );
    setContent(nextValue);
    controller.setControllerState((current) => ({
      ...current,
      selectionStart: nextSelection,
      dismissedMentionKey: controller.mentionTriggerKey,
    }));
    focusTodoEditorInput(composerInputRef.current, nextSelection);
  }

  function handleMentionCreate(name: string) {
    if (!controller.mentionTrigger || !contactMentionOptions.onCreateContact || !name.trim()) {
      return;
    }

    const trigger = controller.mentionTrigger;
    void Promise.resolve(contactMentionOptions.onCreateContact(name.trim())).then((target) => {
      if (!target) {
        return;
      }

      const { nextValue, nextSelection } = insertMentionToken(content, trigger, target);
      setContent(nextValue);
      controller.setControllerState((current) => ({
        ...current,
        selectionStart: nextSelection,
        dismissedMentionKey: controller.mentionTriggerKey,
      }));
      focusTodoEditorInput(composerInputRef.current, nextSelection);
    });
  }

  function handleTagInsert(tag: Parameters<typeof insertTagToken>[2]) {
    if (!controller.tagTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertTagToken(content, controller.tagTrigger, tag);
    setContent(nextValue);
    controller.setControllerState((current) => ({
      ...current,
      selectionStart: nextSelection,
      dismissedTagKey: controller.tagTriggerKey,
    }));
    focusTodoEditorInput(composerInputRef.current, nextSelection);
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

  function renderTodoList(todoList: TodoRecord[], showSources: boolean, allowEmptyClick = false) {
    return (
      <TodoList
        todos={todoList}
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
        onError={onError}
        onOpenInternalReference={onOpenInternalReference}
        onOpenContactMention={onOpenContactMention}
        availableTags={availableTags}
        availableTagScopeProjectId={projectId ?? null}
        canCreateTagsForTodo={canCreateTagsForTodo}
        showTodoSources={showSources}
        onOpenProject={onOpenProject}
        onEmptyClick={
          allowEmptyClick && tab === "unfinished"
            ? () => {
                setIsComposing(true);
              }
            : undefined
        }
      />
    );
  }

  if (todoRailCollapsed) {
    return (
      <aside className="sidebar-dock sidebar-dock--right" aria-label={`${title} 侧边栏`}>
        <button
          type="button"
          className="sidebar-dock__surface sidebar-dock__surface--icon-only"
          title={`展开${title}侧边栏`}
          aria-label="展开代办侧边栏"
          onClick={() => setTodoRailCollapsed(false)}
        >
          <span className="sidebar-dock__icon">
            <ListTodo size={16} />
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      ref={railRef}
      className="todo-rail relative flex shrink-0 flex-col transition-[width] duration-[160ms] ease-[var(--ease-soft)]"
      style={{ width: `${todoRailWidthPx}px` }}
      aria-label={`${title} 侧边栏`}
    >
      <div
        className="todo-rail__handle absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize"
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
      <div className="todo-rail__header flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-title font-medium text-text">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onRefresh ? (
            <IconButton
              type="button"
              size="sm"
              variant="secondary"
              aria-label="刷新代办列表"
              title="刷新代办列表"
              disabled={refreshing}
              onClick={() => void onRefresh()}
            >
              <RefreshCw className={cn(refreshing && "spin")} size={14} />
            </IconButton>
          ) : null}
          <IconButton
            type="button"
            size="sm"
            variant="secondary"
            aria-label="新增代办"
            disabled={!canCreateTodo}
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
        {showViewModeSwitch ? (
          <div className="project-overview-focus__view-switch mb-3" aria-label="Todo View">
            <button
              type="button"
              className={cn(
                "project-overview-focus__view-switch-button",
                viewMode === "current-project" &&
                  "project-overview-focus__view-switch-button--active",
              )}
              aria-pressed={viewMode === "current-project"}
              onClick={() => onViewModeChange?.("current-project")}
            >
              Current Project View
            </button>
            <button
              type="button"
              className={cn(
                "project-overview-focus__view-switch-button",
                viewMode === "workspace" &&
                  "project-overview-focus__view-switch-button--active",
              )}
              aria-pressed={viewMode === "workspace"}
              onClick={() => onViewModeChange?.("workspace")}
            >
              Workspace View
            </button>
          </div>
        ) : null}
        <div className="todo-rail__toolbar mb-3 flex flex-wrap items-center justify-between gap-2">
          <div
            className="project-overview-focus__view-switch"
            data-testid="todo-rail-view-switch"
          >
            <button
              type="button"
              className={cn(
                "project-overview-focus__view-switch-button",
                tab === "unfinished" &&
                  "project-overview-focus__view-switch-button--active",
              )}
              aria-pressed={tab === "unfinished"}
              onClick={() => setTab("unfinished")}
            >
              未完成
            </button>
            <button
              type="button"
              className={cn(
                "project-overview-focus__view-switch-button",
                tab === "finished" &&
                  "project-overview-focus__view-switch-button--active",
              )}
              aria-pressed={tab === "finished"}
              onClick={() => setTab("finished")}
            >
              已完成
            </button>
          </div>

          {showSortSwitch ? <TodoSortSwitch value={sortMode} onChange={setSortMode} /> : null}
        </div>

        {workspaceView ? (
          <div className="project-overview-focus__view-switch mb-3" aria-label="Workspace View 展示方式">
            <button
              type="button"
              className={cn(
                "project-overview-focus__view-switch-button",
                displayMode === "grouped" &&
                  "project-overview-focus__view-switch-button--active",
              )}
              aria-pressed={displayMode === "grouped"}
              onClick={() => setDisplayMode("grouped")}
            >
              分组
            </button>
            <button
              type="button"
              className={cn(
                "project-overview-focus__view-switch-button",
                displayMode === "flat" &&
                  "project-overview-focus__view-switch-button--active",
              )}
              aria-pressed={displayMode === "flat"}
              onClick={() => setDisplayMode("flat")}
            >
              平铺
            </button>
          </div>
        ) : null}

        {isComposing ? (
          <div className="todo-rail__composer mb-3">
            <div className="relative">
              <textarea
                ref={composerInputRef}
                rows={3}
                className="todo-rail__composer-input w-full resize-y text-body text-text outline-none transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] placeholder:text-text-soft"
                value={content}
                onChange={(event) => {
                  const nextSelectionStart = event.target.selectionStart;
                  setContent(event.target.value);
                  controller.setControllerState((current) => ({
                    ...current,
                    selectionStart: nextSelectionStart,
                  }));
                }}
                onClick={(event) => {
                  const nextSelectionStart = event.currentTarget.selectionStart;
                  controller.setControllerState((current) => ({
                    ...current,
                    selectionStart: nextSelectionStart,
                  }));
                }}
                onKeyUp={(event) => {
                  const nextSelectionStart = event.currentTarget.selectionStart;
                  controller.setControllerState((current) => ({
                    ...current,
                    selectionStart: nextSelectionStart,
                  }));
                }}
                onSelect={(event) => {
                  const nextSelectionStart = event.currentTarget.selectionStart;
                  controller.setControllerState((current) => ({
                    ...current,
                    selectionStart: nextSelectionStart,
                  }));
                }}
                onKeyDown={(event) => {
                  if (
                    handleTodoEditorMentionKeyDown({
                      event,
                      open: controller.mentionPickerOpen,
                      optionCount: mentionOptionCount,
                      creatable: controller.mentionCreatable,
                      createIndex: mentionResults.length,
                      activeIndex: controller.controllerState.mentionActiveIndex,
                      triggerKey: controller.mentionTriggerKey,
                      setControllerState: controller.setControllerState,
                      onSelect: () =>
                        handleMentionInsert(
                          mentionResults[controller.controllerState.mentionActiveIndex] ??
                            mentionResults[0],
                        ),
                      onCreate: () => handleMentionCreate(controller.mentionCreateName),
                    })
                  ) {
                    return;
                  }

                  if (
                    handleTodoEditorReferenceKeyDown({
                      event,
                      open: controller.referencePickerOpen,
                      resultCount: referenceResults.length,
                      triggerKey: controller.referenceTriggerKey,
                      setControllerState: controller.setControllerState,
                      onSelect: () =>
                        handleReferenceInsert(
                          referenceResults[controller.controllerState.referenceActiveIndex] ??
                            referenceResults[0],
                        ),
                    })
                  ) {
                    return;
                  }

                  if (
                    handleTodoEditorTagKeyDown({
                      event,
                      open: controller.tagPickerOpen,
                      resultCount: tagResults.length,
                      triggerKey: controller.tagTriggerKey,
                      setControllerState: controller.setControllerState,
                      onSelect: () =>
                        handleTagInsert(
                          tagResults[controller.controllerState.tagActiveIndex] ?? tagResults[0],
                        ),
                    })
                  ) {
                    return;
                  }

                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void submitCreate();
                  }
                }}
                placeholder={createPlaceholder}
              />
              <InternalReferencePicker
                open={controller.referencePickerOpen}
                loading={referenceLoading}
                results={referenceResults}
                activeIndex={controller.controllerState.referenceActiveIndex}
                className="absolute left-0 top-[calc(100%+6px)] z-20 w-[22rem]"
                onHoverIndex={(referenceActiveIndex) =>
                  controller.setControllerState((current) => ({ ...current, referenceActiveIndex }))
                }
                onSelect={handleReferenceInsert}
              />
              <ContactMentionPicker
                open={controller.mentionPickerOpen}
                loading={mentionLoading}
                results={mentionResults}
                activeIndex={controller.controllerState.mentionActiveIndex}
                query={controller.mentionTrigger?.query ?? ""}
                canCreate={controller.mentionCreatable}
                portal
                className="fixed z-[120]"
                style={getTodoEditorPickerPosition(composerInputRef.current)}
                onHoverIndex={(mentionActiveIndex) =>
                  controller.setControllerState((current) => ({ ...current, mentionActiveIndex }))
                }
                onSelect={handleMentionInsert}
                onCreate={handleMentionCreate}
              />
              <TagMentionPicker
                open={controller.tagPickerOpen}
                loading={tagLoading}
                results={tagResults}
                activeIndex={controller.controllerState.tagActiveIndex}
                query={controller.tagTrigger?.query ?? ""}
                canCreate={false}
                portal
                className="fixed z-[120]"
                style={getTodoEditorPickerPosition(composerInputRef.current)}
                onHoverIndex={(tagActiveIndex) =>
                  controller.setControllerState((current) => ({ ...current, tagActiveIndex }))
                }
                onSelect={handleTagInsert}
              />
            </div>
            <div className="todo-rail__composer-meta">
              {createOwnershipOptions ? (
                <label className="relative flex w-full items-center gap-2 text-ui text-text-soft">
                  <span>归属</span>
                  <input
                    role="combobox"
                    aria-label="Todo 归属"
                    aria-expanded={ownershipPickerOpen}
                    aria-controls="todo-ownership-options"
                    aria-autocomplete="list"
                    aria-invalid={
                      createProjectId !== null &&
                      !createOwnershipOptions.some(
                        (option) => option.projectId === createProjectId,
                      )
                    }
                    className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-text"
                    value={ownershipPickerOpen ? ownershipQuery : selectedOwnershipName}
                    onFocus={() => {
                      setOwnershipPickerOpen(true);
                      setOwnershipQuery("");
                    }}
                    onChange={(event) => {
                      setOwnershipPickerOpen(true);
                      setOwnershipQuery(event.target.value);
                    }}
                    onBlur={() => window.setTimeout(() => setOwnershipPickerOpen(false), 0)}
                  />
                  {ownershipPickerOpen ? (
                    <div
                      id="todo-ownership-options"
                      role="listbox"
                      className="absolute left-12 right-0 top-[calc(100%+4px)] z-30 grid max-h-52 overflow-y-auto rounded-md border border-border bg-bg p-1 shadow-lg"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={createProjectId === null}
                        className="rounded px-2 py-1.5 text-left text-text hover:bg-bg-hover"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setCreateProjectId(null);
                          setOwnershipPickerOpen(false);
                          setOwnershipQuery("");
                          controller.setControllerState((current) => ({
                            ...current,
                            ...resetTodoEditorControllerState(),
                          }));
                        }}
                      >
                        Workspace
                      </button>
                      {filteredOwnershipOptions.map((option) => (
                        <button
                          key={option.projectId}
                          type="button"
                          role="option"
                          aria-selected={createProjectId === option.projectId}
                          className="rounded px-2 py-1.5 text-left text-text hover:bg-bg-hover"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setCreateProjectId(option.projectId);
                            setOwnershipPickerOpen(false);
                            setOwnershipQuery("");
                            controller.setControllerState((current) => ({
                              ...current,
                              ...resetTodoEditorControllerState(),
                            }));
                          }}
                        >
                          {option.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </label>
              ) : null}
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
              <div className="todo-rail__composer-hint">Cmd/Ctrl + Enter 保存</div>
            </div>
            <div className="todo-rail__composer-footer">
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={createPending || !canCreateTodo || ownershipUnavailable}
                onClick={() => void submitCreate()}
              >
                保存
              </Button>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {workspaceView && displayMode === "grouped" ? (
            todoGroups.length > 0 ? (
              <div className="grid gap-4">
                {todoGroups.map((group) => (
                  <section key={group.key} className="grid gap-2">
                    <h3 className="text-ui font-semibold text-text-muted">{group.title}</h3>
                    {renderTodoList(group.todos, false)}
                  </section>
                ))}
              </div>
            ) : (
              renderTodoList([], false, true)
            )
          ) : (
            renderTodoList(
              todos,
              workspaceView && displayMode === "flat" ? true : showTodoSources,
              true,
            )
          )}
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
        color: priority === "urgent_not_important" ? "var(--color-text)" : colorValue,
        opacity: active ? 1 : 0.82,
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
