import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, FolderKanban, ListTodo, ListTree, Plus, RefreshCw, X } from "lucide-react";

import {
  splitInternalReferenceText,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import { type ContactMentionTarget } from "../../lib/contactMentions";
import type {
  DocumentTagRecord,
  ProjectTagRecord,
  TodoPriority,
  TodoRecord,
  TodoTagUpdateHandler,
} from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { projectMindApi } from "../../services/projectMindApi";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { focusTargetElement } from "../../hooks/useUtilityHooks";
import { deriveContactPinyin } from "../../lib/pinyin";
import {
  TODO_RAIL_WIDTH_MAX_PX,
  TODO_RAIL_WIDTH_MIN_PX,
  useUiStore,
} from "../../state/ui-store";
import { Button, IconButton, ResizeHandle } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { ContactMentionPicker, useContactMentionSearch } from "../contact";
import {
  InternalReferenceInlineText,
  InternalReferencePicker,
  useInternalReferenceSearch,
} from "../internal-reference";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import { TagMentionPicker, useTagMentionSearch } from "../tags/TagMentionPicker";
import { TodoInlineProgressEditor } from "./TodoInlineProgressEditor";
import { TodoList } from "./TodoList";
import { TodoSortSwitch } from "./TodoSortSwitch";
import { parseDueDateInput, priorityColorValue, sortTodos, TODO_PRIORITY_OPTIONS } from "./todo-utils";
import {
  buildTodoComposerDraftStorageKey,
  clearTodoComposerDraft,
  readTodoComposerDraft,
  writeTodoComposerDraft,
  type TodoComposerDraftSnapshot,
  type TodoComposerSubtaskDraft,
} from "./todo-draft-storage";
import { TodoDueDate } from "./TodoDueDate";
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
  viewMode?: "workspace" | "current-project";
  showViewModeSwitch?: boolean;
  canCreateTodo?: boolean;
  onViewModeChange?: (mode: "workspace" | "current-project") => void;
  createPlaceholder: string;
  createOwnershipOptions?: Array<{ projectId: number; name: string }>;
  onCreateTodo: (payload: {
    content: string;
    priority: TodoPriority;
    dueDate?: string | null;
    projectId?: number | null;
    tagIds?: number[];
    optimisticTags?: DocumentTagRecord[];
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
  scopeLabel,
  unfinishedTodos,
  finishedTodos,
  availableTags = [],
  canCreateTagsForTodo,
  viewMode,
  showViewModeSwitch = false,
  canCreateTodo = true,
  onViewModeChange,
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
  const composerRef = useRef<HTMLDivElement | null>(null);
  const addTodoButtonRef = useRef<HTMLButtonElement | null>(null);
  const currentProjectViewRef = useRef<HTMLButtonElement | null>(null);
  const workspaceViewRef = useRef<HTMLButtonElement | null>(null);
  const initialComposerDraft = readTodoComposerDraft(draftStorageKey);
  const internalReferenceContext =
    projectId === undefined
      ? { scope: "workspace" as const, projectId: null }
      : { scope: "project" as const, projectId };
  const [isComposing, setIsComposing] = useState(() => Boolean(initialComposerDraft));
  const [content, setContent] = useState(
    () => initialComposerDraft?.content ?? "",
  );
  const [priority, setPriority] = useState<TodoPriority>(
    () => initialComposerDraft?.priority ?? "not_urgent_important",
  );
  const [createProjectId, setCreateProjectId] = useState<number | null>(
    () => initialComposerDraft?.projectId ?? null,
  );
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>(
    () => initialComposerDraft?.tagIds ?? [],
  );
  const [draftSubtasks, setDraftSubtasks] = useState<TodoComposerSubtaskDraft[]>(
    () => initialComposerDraft?.subtasks ?? [],
  );
  const [composerCreationOutcome, setComposerCreationOutcome] = useState<
    "created" | "unknown" | null
  >(() => initialComposerDraft?.creationOutcome ?? null);
  const [composerCreatedTags, setComposerCreatedTags] = useState<ProjectTagRecord[]>([]);
  const [ownershipPickerOpen, setOwnershipPickerOpen] = useState(false);
  const [ownershipQuery, setOwnershipQuery] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [composerTagPending, setComposerTagPending] = useState(false);
  const composerLocked = createPending || composerTagPending || composerCreationOutcome !== null;
  const composerInternalReferenceContext =
    createOwnershipOptions && createProjectId !== null
      ? { scope: "project" as const, projectId: createProjectId }
      : internalReferenceContext;
  const composerTagProjectId = createOwnershipOptions ? createProjectId : (projectId ?? null);
  const composerTagSettingsQuery = useQuery({
    queryKey: queryKeys.projectTags.project(createProjectId ?? 0),
    queryFn: () => projectMindApi.projectTagSettingsGet({ projectId: createProjectId! }),
    enabled: Boolean(createOwnershipOptions && createProjectId !== null),
  });
  const composerAvailableTags = useMemo(() => {
    const source =
      createOwnershipOptions && createProjectId !== null
        ? (composerTagSettingsQuery.data?.tags ?? [])
        : availableTags;
    return [...source, ...composerCreatedTags].filter(
      (tag, index, tags) => tags.findIndex((candidate) => candidate.id === tag.id) === index,
    );
  }, [
    availableTags,
    composerCreatedTags,
    composerTagSettingsQuery.data?.tags,
    createOwnershipOptions,
    createProjectId,
  ]);
  const selectedComposerTags = useMemo<DocumentTagRecord[]>(
    () =>
      composerAvailableTags
        .filter((tag) => selectedTagIds.includes(tag.id))
        .map(({ id, label, colorKey }) => ({ id, label, colorKey })),
    [composerAvailableTags, selectedTagIds],
  );
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(() => new Set());
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerTagInputRef = useRef<HTMLInputElement | null>(null);
  const outsideSubmitAfterTagRef = useRef(false);
  const composerTagCommitSucceededRef = useRef(false);
  const composerDraftRef = useRef<{
    key: string;
    snapshot: TodoComposerDraftSnapshot;
  }>({
    key: draftStorageKey,
    snapshot: {
      content: initialComposerDraft?.content ?? "",
      priority: initialComposerDraft?.priority ?? "not_urgent_important",
      projectId: initialComposerDraft?.projectId ?? null,
      tagIds: initialComposerDraft?.tagIds ?? [],
      subtasks: initialComposerDraft?.subtasks ?? [],
      creationOutcome: initialComposerDraft?.creationOutcome ?? null,
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
  const createDisabled =
    createPending ||
    composerTagPending ||
    !canCreateTodo ||
    composerCreationOutcome !== null ||
    ownershipUnavailable ||
    !content.trim();

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
    let clearFocusCue: (() => void) | undefined;
    const frameId = window.requestAnimationFrame(() => {
      const element = railRef.current?.querySelector<HTMLElement>(
        `[data-todo-id="${focusTodoId}"]`,
      );
      if (element) {
        clearFocusCue = focusTargetElement(element, { block: "nearest" });
      }
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      clearFocusCue?.();
    };
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
      composerInputRef.current?.focus();
      return;
    }

    controller.setControllerState((current) => ({
      ...current,
      ...resetTodoEditorControllerState(),
    }));
  }, [isComposing]);

  useEffect(() => {
    if (!isComposing || !composerInputRef.current) return;
    const input = composerInputRef.current;
    const styles = window.getComputedStyle(input);
    const fontSize = Number.parseFloat(styles.fontSize) || 16;
    const rawLineHeight = Number.parseFloat(styles.lineHeight);
    const lineHeight = rawLineHeight > 4 ? rawLineHeight : (rawLineHeight || 1.55) * fontSize;
    const verticalPadding =
      (Number.parseFloat(styles.paddingTop) || 0) +
      (Number.parseFloat(styles.paddingBottom) || 0);
    const maxHeight = lineHeight * 6 + verticalPadding;
    input.style.height = "auto";
    input.style.maxHeight = `${maxHeight}px`;
    input.style.height = `${Math.max(lineHeight + verticalPadding, Math.min(input.scrollHeight, maxHeight))}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [content, isComposing]);

  useEffect(() => {
    if (!isComposing) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || createPending || composerTagPending) return;
      if (composerCreationOutcome !== null) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".todo-subtask-editor, .entity-tag-chip--input")
      ) {
        return;
      }
      event.preventDefault();
      resetComposer(true);
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  });

  useEffect(() => {
    if (!isComposing) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (createPending || composerTagPending || composerCreationOutcome !== null) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        composerRef.current?.contains(target) ||
        target.closest(
          ".contact-mention-picker, .tag-mention-picker, .internal-reference-picker, #todo-ownership-options",
        )
      ) {
        return;
      }
      if (composerTagInputRef.current?.value.trim()) {
        outsideSubmitAfterTagRef.current = true;
        composerTagCommitSucceededRef.current = false;
        composerTagInputRef.current.blur();
        return;
      }
      if (content.trim()) {
        void submitCreate();
      } else {
        resetComposer(false);
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  });

  useEffect(() => {
    if (!outsideSubmitAfterTagRef.current || composerTagPending) return;
    outsideSubmitAfterTagRef.current = false;
    if (!composerTagCommitSucceededRef.current) return;
    if (content.trim()) {
      void submitCreate();
    } else {
      resetComposer(false);
    }
  });

  useEffect(() => {
    const snapshot = readTodoComposerDraft(draftStorageKey);
    setContent(snapshot?.content ?? "");
    setPriority(snapshot?.priority ?? "not_urgent_important");
    setCreateProjectId(snapshot?.projectId ?? null);
    setSelectedTagIds(snapshot?.tagIds ?? []);
    setDraftSubtasks(snapshot?.subtasks ?? []);
    setComposerCreationOutcome(snapshot?.creationOutcome ?? null);
    setComposerCreatedTags([]);
    setIsComposing(Boolean(snapshot));
    controller.setControllerState((current) => ({
      ...current,
      ...resetTodoEditorControllerState(),
    }));
  }, [controller.setControllerState, draftStorageKey]);

  useEffect(() => {
    const snapshot = {
      content,
      priority,
      projectId: createProjectId,
      tagIds: selectedTagIds,
      subtasks: draftSubtasks,
      creationOutcome: composerCreationOutcome,
    };
    composerDraftRef.current = { key: draftStorageKey, snapshot };
    writeTodoComposerDraft(draftStorageKey, snapshot);
  }, [
    composerCreationOutcome,
    content,
    createProjectId,
    draftStorageKey,
    draftSubtasks,
    priority,
    selectedTagIds,
  ]);

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
    if (composerTagPending || composerCreationOutcome !== null) {
      return;
    }
    if (composerCreationOutcome === null && !content.trim()) {
      return;
    }
    if (composerCreationOutcome === null && ownershipUnavailable) {
      onError?.("所选 Project 已不可用，请重新选择归属。");
      return;
    }
    setCreatePending(true);
    try {
      const parsed = parseDueDateInput(content);
      if (!parsed.ok) {
        onError?.(parsed.error);
        return;
      }
      const createdTodo = await onCreateTodo({
        content: parsed.content,
        priority,
        ...(createOwnershipOptions ? { projectId: createProjectId } : {}),
        ...(parsed.dueDate ? { dueDate: parsed.dueDate } : {}),
        ...(selectedTagIds.length > 0
          ? { tagIds: selectedTagIds, optimisticTags: selectedComposerTags }
          : {}),
      });
      if (draftSubtasks.length === 0) {
        resetComposer(false);
        return;
      }
      const targetTodoId = readCreatedTodoId(createdTodo);
      persistComposerRecovery(draftSubtasks, "created");
      if (targetTodoId === null) {
        await refreshAfterAmbiguousWrite(
          "Todo 已创建，但无法识别新 Todo；Subtask 草稿已保留。",
        );
        return;
      }

      const subtasksToAdd = draftSubtasks;
      for (let index = 0; index < subtasksToAdd.length; index += 1) {
        try {
          await onAddProgress(targetTodoId, subtasksToAdd[index]);
          persistComposerRecovery(subtasksToAdd.slice(index + 1), "created");
        } catch (error) {
          const remaining = subtasksToAdd.slice(index);
          persistComposerRecovery(remaining, "created");
          await refreshAfterAmbiguousWrite(
            `Todo 已创建；仍有 ${remaining.length} 个 Subtask 草稿需核对后手动添加：${String(error)}`,
          );
          return;
        }
      }
      resetComposer(false);
    } catch (error) {
      persistComposerRecovery(draftSubtasks, "unknown");
      await refreshAfterAmbiguousWrite(
        `Todo 创建结果无法确认，草稿已保留：${String(error)}`,
      );
    } finally {
      setCreatePending(false);
    }
  }

  async function refreshAfterAmbiguousWrite(message: string) {
    if (!onRefresh) {
      onError?.(`${message}；请刷新 Todo 列表后核对。`);
      return;
    }
    try {
      await onRefresh();
      onError?.(`${message}；Todo 列表已刷新，请核对。`);
    } catch (refreshError) {
      onError?.(`${message}；Todo 列表刷新失败，请保持草稿并稍后重试：${String(refreshError)}`);
    }
  }

  function persistComposerRecovery(
    subtasks: TodoComposerSubtaskDraft[],
    creationOutcome: "created" | "unknown",
  ) {
    const snapshot: TodoComposerDraftSnapshot = {
      content,
      priority,
      projectId: createProjectId,
      tagIds: selectedTagIds,
      subtasks,
      creationOutcome,
    };
    composerDraftRef.current = { key: draftStorageKey, snapshot };
    writeTodoComposerDraft(draftStorageKey, snapshot);
    setDraftSubtasks(subtasks);
    setComposerCreationOutcome(creationOutcome);
  }

  function resetComposer(restoreFocus: boolean) {
    clearTodoComposerDraft(draftStorageKey);
    setContent("");
    setPriority("not_urgent_important");
    if (createOwnershipOptions) setCreateProjectId(null);
    setSelectedTagIds([]);
    setDraftSubtasks([]);
    setComposerCreationOutcome(null);
    setComposerCreatedTags([]);
    setComposerTagPending(false);
    setOwnershipPickerOpen(false);
    setOwnershipQuery("");
    setIsComposing(false);
    controller.setControllerState((current) => ({
      ...current,
      ...resetTodoEditorControllerState(),
    }));
    if (restoreFocus) {
      window.requestAnimationFrame(() => addTodoButtonRef.current?.focus());
    }
  }

  function continueComposerAfterUnknownCreation() {
    const snapshot: TodoComposerDraftSnapshot = {
      content,
      priority,
      projectId: createProjectId,
      tagIds: selectedTagIds,
      subtasks: draftSubtasks,
      creationOutcome: null,
    };
    composerDraftRef.current = { key: draftStorageKey, snapshot };
    writeTodoComposerDraft(draftStorageKey, snapshot);
    setComposerCreationOutcome(null);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
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

  function selectComposerOwnership(nextProjectId: number | null) {
    if (nextProjectId !== createProjectId) {
      const containsScopedReference = [content, ...draftSubtasks.map((subtask) => subtask.content)]
        .some((value) =>
          splitInternalReferenceText(value).some((segment) => segment.type === "reference"),
        );
      if (containsScopedReference) {
        setOwnershipPickerOpen(false);
        setOwnershipQuery("");
        onError?.("请先移除 Todo 与 Subtask 中的 Internal Reference，再切换归属。");
        return;
      }
      setSelectedTagIds([]);
      setComposerCreatedTags([]);
    }
    setCreateProjectId(nextProjectId);
    setOwnershipPickerOpen(false);
    setOwnershipQuery("");
    controller.setControllerState((current) => ({
      ...current,
      ...resetTodoEditorControllerState(),
    }));
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

  function renderTodoList(todoList: TodoRecord[], allowEmptyClick = false) {
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
      className="todo-rail relative flex shrink-0 flex-col"
      style={{ width: `${todoRailWidthPx}px` }}
      aria-label={`${title} 侧边栏`}
    >
      <ResizeHandle
        label="调整 Todo Rail 宽度"
        edge="left"
        value={todoRailWidthPx}
        min={TODO_RAIL_WIDTH_MIN_PX}
        max={TODO_RAIL_WIDTH_MAX_PX}
        onChange={setTodoRailWidthPx}
        className="left-0"
      />
      <div className="todo-rail__header flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-title font-medium text-text">{title}</h2>
          <p className="todo-rail__scope">{scopeLabel}</p>
          {showViewModeSwitch ? (
            <div
              className="todo-rail__view-switch"
              role="tablist"
              aria-label="Todo View"
            >
              <button
                ref={currentProjectViewRef}
                type="button"
                role="tab"
                aria-selected={!workspaceView}
                tabIndex={!workspaceView ? 0 : -1}
                className="todo-rail__view-switch-button"
                onClick={() => onViewModeChange?.("current-project")}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowDown" && event.key !== "End") {
                    return;
                  }
                  event.preventDefault();
                  workspaceViewRef.current?.focus();
                  onViewModeChange?.("workspace");
                }}
              >
                Current Project View
              </button>
              <button
                ref={workspaceViewRef}
                type="button"
                role="tab"
                aria-selected={workspaceView}
                tabIndex={workspaceView ? 0 : -1}
                className="todo-rail__view-switch-button"
                onClick={() => onViewModeChange?.("workspace")}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowUp" && event.key !== "Home") {
                    return;
                  }
                  event.preventDefault();
                  currentProjectViewRef.current?.focus();
                  onViewModeChange?.("current-project");
                }}
              >
                Workspace View
              </button>
            </div>
          ) : null}
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
            ref={addTodoButtonRef}
            type="button"
            size="sm"
            variant="secondary"
            aria-label="新增代办"
            disabled={!canCreateTodo || isComposing}
            onClick={() => setIsComposing(true)}
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
        <div className="todo-rail__toolbar mb-3 flex flex-nowrap items-center justify-between gap-2">
          <div
            className="todo-rail__segmented-control project-overview-focus__view-switch"
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

          <div className="flex items-center gap-1.5">
            {workspaceView ? (
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                className="todo-rail__icon-toggle"
                aria-label="分组显示"
                aria-pressed={displayMode === "grouped"}
                title={
                  displayMode === "grouped"
                    ? "分组显示（点击切换为平铺）"
                    : "平铺显示（点击切换为分组）"
                }
                onClick={() =>
                  setDisplayMode(displayMode === "grouped" ? "flat" : "grouped")
                }
              >
                <ListTree size={14} />
              </IconButton>
            ) : null}
            {showSortSwitch ? (
              <TodoSortSwitch value={sortMode} onChange={setSortMode} />
            ) : null}
          </div>
        </div>

        {isComposing ? (
          <div
            ref={composerRef}
            className={cn(
              "todo-rail__composer mb-3",
              (createPending || composerTagPending) && "todo-rail__composer--pending",
            )}
            aria-busy={createPending || composerTagPending}
            data-testid="todo-composer-card"
            style={
              {
                "--todo-priority-color": priorityColorValue(priority),
              } as CSSProperties
            }
          >
            <span className="todo-rail__composer-priority-rail" aria-hidden="true" />
            <div className="todo-rail__composer-card-body">
              <div className="todo-rail__composer-primary">
                <div className="relative">
              <textarea
                ref={composerInputRef}
                rows={1}
                data-max-lines="6"
                disabled={composerLocked}
                className="todo-editor-field todo-rail__composer-input w-full resize-none text-body text-text placeholder:text-text-soft"
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
                  if (composerLocked) return;
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

                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void submitCreate();
                  }
                }}
                placeholder={createPlaceholder}
              />
              <InternalReferencePicker
                open={controller.referencePickerOpen && !composerLocked}
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
                open={controller.mentionPickerOpen && !composerLocked}
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
                open={controller.tagPickerOpen && !composerLocked}
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
                <div className="todo-rail__composer-tags">
                  <EntityTagEditor
                    key={composerTagProjectId ?? "workspace"}
                    projectId={composerTagProjectId}
                    availableTags={composerAvailableTags}
                    tags={selectedComposerTags}
                    busy={composerLocked}
                    inputRef={composerTagInputRef}
                    compact
                    mode="full"
                    onCreated={(tag) => {
                      setComposerCreatedTags((current) => [
                        ...current.filter((candidate) => candidate.id !== tag.id),
                        tag,
                      ]);
                    }}
                    onChange={(tagIds) => setSelectedTagIds(tagIds)}
                    onPendingChange={setComposerTagPending}
                    onCommitSettled={(error) => {
                      composerTagCommitSucceededRef.current = error === null;
                      if (error !== null) {
                        onError?.(`Tag 保存失败：${String(error)}`);
                      }
                    }}
                  />
                </div>
                {composerCreationOutcome !== null ? (
                  <div className="todo-rail__composer-recovery">
                    <p role="status">
                      {composerCreationOutcome === "created"
                        ? `Todo 已创建；仍有 ${draftSubtasks.length} 个 Subtask 草稿需核对后手动添加。`
                        : "Todo 创建结果无法确认；请先核对 Todo 列表。"}
                    </p>
                    <div className="todo-rail__composer-recovery-actions">
                      {composerCreationOutcome === "unknown" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={continueComposerAfterUnknownCreation}
                        >
                          确认未创建，继续编辑
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => resetComposer(false)}
                      >
                        已核对，清除草稿
                      </Button>
                    </div>
                  </div>
                ) : null}
                <div className="todo-rail__composer-subtasks">
                  {draftSubtasks.length > 0 ? (
                    <div className="todo-rail__composer-subtask-list">
                      {draftSubtasks.map((subtask, index) => (
                        <div
                          key={`${subtask.content}:${subtask.progressDate}:${index}`}
                          className="todo-rail__composer-subtask-row"
                        >
                          <span
                            className="todo-subtask-editor-row__check-placeholder"
                            aria-hidden="true"
                          />
                          <p className="min-w-0 flex-1 text-ui leading-[1.2rem] text-text-muted">
                            <InternalReferenceInlineText
                              value={subtask.content}
                              className="break-words"
                              variant="todo-inline"
                              onOpenInternalReference={onOpenInternalReference}
                              onOpenContactMention={onOpenContactMention}
                            />
                            {subtask.dueDate ? <TodoDueDate value={subtask.dueDate} /> : null}
                          </p>
                          <IconButton
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`移除 Subtask ${subtask.content}`}
                            disabled={createPending || composerTagPending}
                            onClick={() =>
                              setDraftSubtasks((current) =>
                                current.filter((_, candidateIndex) => candidateIndex !== index),
                              )
                            }
                          >
                            <X size={12} />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="todo-rail__composer-add-subtask">
                    <TodoInlineProgressEditor
                      latestProgress={null}
                      editable={!composerLocked}
                      onError={onError}
                      internalReferenceContext={composerInternalReferenceContext}
                      onOpenInternalReference={onOpenInternalReference}
                      onOpenContactMention={onOpenContactMention}
                      onSave={(subtask) => {
                        setDraftSubtasks((current) => [...current, subtask]);
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="todo-rail__composer-meta">
              {createOwnershipOptions ? (
                <label className="todo-rail__ownership relative flex min-w-0 flex-[1_1_12rem] items-center gap-2 text-ui text-text-soft">
                  <FolderKanban aria-hidden="true" size={14} />
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
                    disabled={composerLocked}
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
                        disabled={composerLocked}
                        role="option"
                        aria-selected={createProjectId === null}
                        className="rounded px-2 py-1.5 text-left text-text hover:bg-bg-hover"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectComposerOwnership(null)}
                      >
                        Workspace
                      </button>
                      {filteredOwnershipOptions.map((option) => (
                        <button
                          key={option.projectId}
                          type="button"
                          disabled={composerLocked}
                          role="option"
                          aria-selected={createProjectId === option.projectId}
                          className="rounded px-2 py-1.5 text-left text-text hover:bg-bg-hover"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectComposerOwnership(option.projectId)}
                        >
                          {option.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </label>
              ) : null}
              <div className="todo-rail__priority-options" aria-label="Todo 优先级">
                {TODO_PRIORITY_OPTIONS.map((option) => (
                  <PriorityDotButton
                    key={option.value}
                    priority={option.value}
                    active={priority === option.value}
                    title={option.optionLabel}
                    onClick={() => setPriority(option.value)}
                    disabled={composerLocked}
                  />
                ))}
              </div>
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={createDisabled}
                onClick={() => void submitCreate()}
              >
                {createPending
                  ? "创建中…"
                  : composerCreationOutcome === "created"
                    ? "Todo 已创建"
                    : composerCreationOutcome === "unknown"
                      ? "请先核对"
                      : "创建"}
              </Button>
              </div>
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
                    {renderTodoList(group.todos)}
                  </section>
                ))}
              </div>
            ) : (
              renderTodoList([], true)
            )
          ) : (
            renderTodoList(todos, true)
          )}
        </div>
      </div>
    </aside>
  );
}

function readCreatedTodoId(value: unknown) {
  if (!value || typeof value !== "object" || !("id" in value)) {
    return null;
  }
  return typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0
    ? value.id
    : null;
}

function PriorityDotButton({
  active,
  priority,
  title,
  onClick,
  disabled,
}: {
  active: boolean;
  priority: TodoPriority;
  title?: string;
  onClick: () => void;
  disabled: boolean;
}) {
  const colorValue = priorityColorValue(priority);

  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={active}
      title={title}
      disabled={disabled}
      className="todo-rail__priority-button"
      onClick={onClick}
    >
      <span
        className={cn("todo-rail__priority-dot", active && "todo-rail__priority-dot--active")}
        style={{ backgroundColor: colorValue }}
      />
    </button>
  );
}
