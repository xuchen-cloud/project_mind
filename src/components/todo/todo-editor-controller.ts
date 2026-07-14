import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import {
  buildContactMentionTarget,
  buildContactMentionToken,
  findContactMentionTextTrigger,
  type ContactMentionTarget,
} from "../../lib/contactMentions";
import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
  findInternalReferenceTextTrigger,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import { findHashTagTextTrigger } from "../../lib/tags";
import type {
  ContactRecord,
  ProjectTagRecord,
  InternalReferenceContext,
  InternalReferenceSearchResult,
} from "../../lib/types";
import { replaceTodoTextTrigger } from "./todo-text-tokens";

export interface TodoEditorControllerState {
  selectionStart: number | null;
  referenceActiveIndex: number;
  dismissedTriggerKey: string | null;
  mentionActiveIndex: number;
  dismissedMentionKey: string | null;
  tagActiveIndex: number;
  dismissedTagKey: string | null;
}

export interface TodoEditorControllerContext {
  draft: string;
  editing: boolean;
  internalReferenceContext?: InternalReferenceContext | null;
  disableMentionTrigger?: (trigger: { start: number; end: number }) => boolean;
  canCreateMentions?: boolean;
}

interface TodoEditorDerivedStateContext extends TodoEditorControllerContext {
  selectionStart: number | null;
}

interface UseTodoEditorControllerOptions extends TodoEditorControllerContext {}

export function createTodoEditorControllerState(): TodoEditorControllerState {
  return {
    selectionStart: null,
    referenceActiveIndex: 0,
    dismissedTriggerKey: null,
    mentionActiveIndex: 0,
    dismissedMentionKey: null,
    tagActiveIndex: 0,
    dismissedTagKey: null,
  };
}

export function resetTodoEditorControllerState(): Partial<TodoEditorControllerState> {
  return {
    selectionStart: null,
    referenceActiveIndex: 0,
    dismissedTriggerKey: null,
    mentionActiveIndex: 0,
    dismissedMentionKey: null,
    tagActiveIndex: 0,
    dismissedTagKey: null,
  };
}

export function getTodoEditorDerivedState({
  draft,
  editing,
  selectionStart,
  internalReferenceContext,
  disableMentionTrigger,
  canCreateMentions = false,
}: TodoEditorDerivedStateContext) {
  const referenceTrigger = editing
    ? findInternalReferenceTextTrigger(draft, selectionStart)
    : null;
  const referenceTriggerKey = referenceTrigger
    ? `${referenceTrigger.start}:${referenceTrigger.end}:${referenceTrigger.query}`
    : null;

  const mentionCandidate = editing
    ? findContactMentionTextTrigger(draft, selectionStart)
    : null;
  const mentionTrigger =
    mentionCandidate &&
    (/^\d+$/u.test(mentionCandidate.query) || disableMentionTrigger?.(mentionCandidate))
      ? null
      : mentionCandidate;
  const mentionTriggerKey = mentionTrigger
    ? `${mentionTrigger.start}:${mentionTrigger.end}:${mentionTrigger.query}`
    : null;

  const tagTrigger = editing ? findHashTagTextTrigger(draft, selectionStart) : null;
  const tagTriggerKey = tagTrigger
    ? `${tagTrigger.start}:${tagTrigger.end}:${tagTrigger.query}`
    : null;

  const mentionCreateName = mentionTrigger?.query.trim() ?? "";
  const mentionCreatable = canCreateMentions && mentionCreateName.length > 0;

  return {
    referenceTrigger,
    referenceTriggerKey,
    mentionTrigger,
    mentionTriggerKey,
    tagTrigger,
    tagTriggerKey,
    mentionCreateName,
    mentionCreatable,
    hasProjectTagContext: Boolean(internalReferenceContext?.projectId),
  };
}

export function useTodoEditorController({
  draft,
  editing,
  internalReferenceContext,
  disableMentionTrigger,
  canCreateMentions = false,
}: UseTodoEditorControllerOptions) {
  const [controllerState, setControllerState] = useState(createTodoEditorControllerState);
  const derivedState = getTodoEditorDerivedState({
    draft,
    editing,
    selectionStart: controllerState.selectionStart,
    internalReferenceContext,
    disableMentionTrigger,
    canCreateMentions,
  });
  const referencePickerOpen =
    Boolean(derivedState.referenceTrigger) &&
    Boolean(internalReferenceContext) &&
    controllerState.dismissedTriggerKey !== derivedState.referenceTriggerKey;
  const mentionPickerOpen =
    Boolean(derivedState.mentionTrigger) &&
    controllerState.dismissedMentionKey !== derivedState.mentionTriggerKey;
  const tagPickerOpen =
    Boolean(derivedState.tagTrigger) &&
    derivedState.hasProjectTagContext &&
    controllerState.dismissedTagKey !== derivedState.tagTriggerKey;

  useEffect(() => {
    if (!editing) {
      setControllerState((current) => ({ ...current, ...resetTodoEditorControllerState() }));
    }
  }, [editing]);

  return {
    controllerState,
    setControllerState,
    referencePickerOpen,
    mentionPickerOpen,
    tagPickerOpen,
    ...derivedState,
  };
}

export function useSyncTodoEditorPickerState({
  referencePickerOpen,
  referenceQuery,
  referenceResultCount,
  mentionPickerOpen,
  mentionQuery,
  mentionOptionCount,
  tagPickerOpen,
  tagQuery,
  tagResultCount,
  setControllerState,
}: {
  referencePickerOpen: boolean;
  referenceQuery?: string;
  referenceResultCount: number;
  mentionPickerOpen: boolean;
  mentionQuery?: string;
  mentionOptionCount: number;
  tagPickerOpen: boolean;
  tagQuery?: string;
  tagResultCount: number;
  setControllerState: Dispatch<SetStateAction<TodoEditorControllerState>>;
}) {
  useEffect(() => {
    if (!referencePickerOpen) {
      setControllerState((current) => ({ ...current, referenceActiveIndex: 0 }));
      return;
    }

    setControllerState((current) => ({
      ...current,
      referenceActiveIndex: clampTodoEditorActiveIndex(
        current.referenceActiveIndex,
        referenceResultCount,
      ),
    }));
  }, [referencePickerOpen, referenceResultCount, setControllerState]);

  useEffect(() => {
    if (!referencePickerOpen) {
      return;
    }

    setControllerState((current) => ({ ...current, referenceActiveIndex: 0 }));
  }, [referencePickerOpen, referenceQuery, setControllerState]);

  useEffect(() => {
    if (!mentionPickerOpen) {
      setControllerState((current) => ({ ...current, mentionActiveIndex: 0 }));
      return;
    }

    setControllerState((current) => ({
      ...current,
      mentionActiveIndex: clampTodoEditorActiveIndex(
        current.mentionActiveIndex,
        mentionOptionCount,
      ),
    }));
  }, [mentionOptionCount, mentionPickerOpen, setControllerState]);

  useEffect(() => {
    if (!mentionPickerOpen) {
      return;
    }

    setControllerState((current) => ({ ...current, mentionActiveIndex: 0 }));
  }, [mentionPickerOpen, mentionQuery, setControllerState]);

  useEffect(() => {
    if (!tagPickerOpen) {
      setControllerState((current) => ({ ...current, tagActiveIndex: 0 }));
      return;
    }

    setControllerState((current) => ({
      ...current,
      tagActiveIndex: clampTodoEditorActiveIndex(current.tagActiveIndex, tagResultCount),
    }));
  }, [tagPickerOpen, tagResultCount, setControllerState]);

  useEffect(() => {
    if (!tagPickerOpen) {
      return;
    }

    setControllerState((current) => ({ ...current, tagActiveIndex: 0 }));
  }, [tagPickerOpen, tagQuery, setControllerState]);
}

export function clampTodoEditorActiveIndex(current: number, count: number) {
  if (count === 0) {
    return 0;
  }

  return Math.min(current, count - 1);
}

export function cycleTodoEditorActiveIndex(current: number, count: number, direction: 1 | -1) {
  if (count === 0) {
    return 0;
  }

  if (direction > 0) {
    return (current + 1) % count;
  }

  return current === 0 ? count - 1 : current - 1;
}

export function focusTodoEditorInput(
  target: HTMLDivElement | HTMLTextAreaElement | null,
  selectionStart?: number | null,
) {
  window.requestAnimationFrame(() => {
    target?.focus();

    if (target instanceof HTMLTextAreaElement && typeof selectionStart === "number") {
      target.setSelectionRange(selectionStart, selectionStart);
    }
  });
}

export function insertInternalReferenceToken(
  draft: string,
  trigger: { start: number; end: number },
  reference: InternalReferenceSearchResult,
) {
  const token = `${buildInternalReferenceToken(buildInternalReferenceTarget(reference))} `;
  return replaceTodoTextTrigger(draft, trigger, token);
}

export function insertTagToken(
  draft: string,
  trigger: { start: number; end: number },
  tag: Pick<ProjectTagRecord, "label">,
) {
  return replaceTodoTextTrigger(draft, trigger, `#${tag.label} `);
}

export function insertMentionToken(
  draft: string,
  trigger: { start: number; end: number },
  contact: ContactRecord | ContactMentionTarget,
) {
  const target = buildContactMentionTarget(contact as ContactRecord | ContactMentionTarget);
  return replaceTodoTextTrigger(
    draft,
    trigger,
    `${buildContactMentionToken(target)} `,
  );
}

export function getTodoEditorPickerPosition(target: HTMLElement | null) {
  if (!target) {
    return undefined;
  }

  const rect = target.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.bottom + 6,
  };
}

export function handleTodoEditorMentionKeyDown({
  event,
  open,
  optionCount,
  creatable,
  createIndex,
  activeIndex,
  triggerKey,
  setControllerState,
  onSelect,
  onCreate,
}: {
  event: Pick<KeyboardEvent, "key" | "preventDefault">;
  open: boolean;
  optionCount: number;
  creatable: boolean;
  createIndex: number;
  activeIndex: number;
  triggerKey: string | null;
  setControllerState: Dispatch<SetStateAction<TodoEditorControllerState>>;
  onSelect: () => void;
  onCreate: () => void;
}) {
  if (!open) {
    return false;
  }

  if (event.key === "ArrowDown" && optionCount > 0) {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      mentionActiveIndex: cycleTodoEditorActiveIndex(current.mentionActiveIndex, optionCount, 1),
    }));
    return true;
  }

  if (event.key === "ArrowUp" && optionCount > 0) {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      mentionActiveIndex: cycleTodoEditorActiveIndex(current.mentionActiveIndex, optionCount, -1),
    }));
    return true;
  }

  if (event.key === "Enter" && optionCount > 0) {
    event.preventDefault();
    if (creatable && activeIndex === createIndex) {
      onCreate();
    } else {
      onSelect();
    }
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      dismissedMentionKey: triggerKey,
    }));
    return true;
  }

  return false;
}

export function handleTodoEditorReferenceKeyDown({
  event,
  open,
  resultCount,
  triggerKey,
  setControllerState,
  onSelect,
}: {
  event: Pick<KeyboardEvent, "key" | "preventDefault">;
  open: boolean;
  resultCount: number;
  triggerKey: string | null;
  setControllerState: Dispatch<SetStateAction<TodoEditorControllerState>>;
  onSelect: () => void;
}) {
  if (!open) {
    return false;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      referenceActiveIndex: cycleTodoEditorActiveIndex(
        current.referenceActiveIndex,
        resultCount,
        1,
      ),
    }));
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      referenceActiveIndex: cycleTodoEditorActiveIndex(
        current.referenceActiveIndex,
        resultCount,
        -1,
      ),
    }));
    return true;
  }

  if (event.key === "Enter" && resultCount > 0) {
    event.preventDefault();
    onSelect();
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      dismissedTriggerKey: triggerKey,
    }));
    return true;
  }

  return false;
}

export function handleTodoEditorTagKeyDown({
  event,
  open,
  resultCount,
  triggerKey,
  setControllerState,
  onSelect,
}: {
  event: Pick<KeyboardEvent, "key" | "preventDefault">;
  open: boolean;
  resultCount: number;
  triggerKey: string | null;
  setControllerState: Dispatch<SetStateAction<TodoEditorControllerState>>;
  onSelect: () => void;
}) {
  if (!open) {
    return false;
  }

  if (event.key === "ArrowDown" && resultCount > 0) {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      tagActiveIndex: cycleTodoEditorActiveIndex(current.tagActiveIndex, resultCount, 1),
    }));
    return true;
  }

  if (event.key === "ArrowUp" && resultCount > 0) {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      tagActiveIndex: cycleTodoEditorActiveIndex(current.tagActiveIndex, resultCount, -1),
    }));
    return true;
  }

  if (event.key === "Enter" && resultCount > 0) {
    event.preventDefault();
    onSelect();
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    setControllerState((current) => ({
      ...current,
      dismissedTagKey: triggerKey,
    }));
    return true;
  }

  return false;
}
