import { useEffect, useRef, useState } from "react";

import type { ContactMentionTarget } from "../../lib/contactMentions";
import type { InternalReferenceTarget } from "../../lib/internalReferences";
import type { ContactRecord, InternalReferenceContext } from "../../lib/types";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { ContactMentionPicker, useContactMentionSearch } from "../contact";
import {
  InternalReferenceInlineText,
  InternalReferencePicker,
  useInternalReferenceSearch,
} from "../internal-reference";
import { TagMentionPicker, useTagMentionSearch } from "../tags/TagMentionPicker";
import { TodoReferenceEditor } from "./TodoReferenceEditor";
import { cn } from "../../ui/lib/cn";
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

export function TodoInlineContentEditor({
  value,
  editable,
  onSave,
  internalReferenceContext,
  onOpenInternalReference,
  onOpenContactMention,
  onEditingChange,
}: {
  value: string;
  editable: boolean;
  onSave: (content: string) => Promise<unknown> | void;
  internalReferenceContext?: InternalReferenceContext | null;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPulse, setSavedPulse] = useState(false);
  const contactMentionOptions = useContactMentionOptions();
  const saveInFlightRef = useRef(false);
  const skipBlurSaveRef = useRef(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const controller = useTodoEditorController({
    draft,
    editing,
    internalReferenceContext,
    canCreateMentions: Boolean(contactMentionOptions.onCreateContact),
  });
  const { results: referenceResults, loading: referenceLoading } = useInternalReferenceSearch({
    open: controller.referencePickerOpen,
    query: controller.referenceTrigger?.query ?? "",
    context: internalReferenceContext,
    limit: 8,
  });
  const { results: mentionResults, loading: mentionLoading } = useContactMentionSearch({
    open: controller.mentionPickerOpen,
    query: controller.mentionTrigger?.query ?? "",
    limit: 8,
  });
  const mentionOptionCount =
    mentionResults.length + (controller.mentionCreatable ? 1 : 0);
  const { results: tagResults, loading: tagLoading } = useTagMentionSearch({
    open: controller.tagPickerOpen,
    query: controller.tagTrigger?.query ?? "",
    projectId: internalReferenceContext?.projectId,
    limit: 8,
  });

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
    if (!editing) {
      setDraft(value);
      controller.setControllerState((current) => ({
        ...current,
        ...resetTodoEditorControllerState(),
      }));
    }
  }, [controller, editing, value]);

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  useEffect(() => {
    if (!savedPulse) {
      return;
    }
    const timer = window.setTimeout(() => setSavedPulse(false), 160);
    return () => window.clearTimeout(timer);
  }, [savedPulse]);

  async function handleSave() {
    if (saveInFlightRef.current) {
      return;
    }
    const next = draft.replace(/\r?\n+/gu, " ").trim();
    if (!next) {
      setDraft(value);
      setEditing(false);
      return;
    }
    if (next === value.trim()) {
      setEditing(false);
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
      setSavedPulse(true);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  function handleReferenceSelect(reference: Parameters<typeof insertInternalReferenceToken>[2]) {
    if (!controller.referenceTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertInternalReferenceToken(
      draft,
      controller.referenceTrigger,
      reference,
    );
    setDraft(nextValue);
    controller.setControllerState((current) => ({
      ...current,
      selectionStart: nextSelection,
      dismissedTriggerKey: null,
    }));
    focusTodoEditorInput(editorRef.current);
  }

  function handleTagSelect(tag: Parameters<typeof insertTagToken>[2]) {
    if (!controller.tagTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertTagToken(draft, controller.tagTrigger, tag);
    setDraft(nextValue);
    controller.setControllerState((current) => ({
      ...current,
      selectionStart: nextSelection,
      dismissedTagKey: controller.tagTriggerKey,
    }));
    focusTodoEditorInput(editorRef.current);
  }

  function handleMentionSelect(contact: ContactRecord) {
    if (!controller.mentionTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertMentionToken(
      draft,
      controller.mentionTrigger,
      contact,
    );
    setDraft(nextValue);
    controller.setControllerState((current) => ({
      ...current,
      selectionStart: nextSelection,
      dismissedMentionKey: controller.mentionTriggerKey,
    }));
    focusTodoEditorInput(editorRef.current);
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

      const { nextValue, nextSelection } = insertMentionToken(draft, trigger, target);
      setDraft(nextValue);
      controller.setControllerState((current) => ({
        ...current,
        selectionStart: nextSelection,
        dismissedMentionKey: controller.mentionTriggerKey,
      }));
      focusTodoEditorInput(editorRef.current);
    });
  }

  if (editing) {
    return (
      <div className="relative">
        <TodoReferenceEditor
          editorRef={editorRef}
          value={draft}
          selectionOffset={controller.controllerState.selectionStart}
          containerClassName="todo-inline-editor"
          autoFocus
          disabled={saving}
          textClassName="text-body leading-6 font-medium"
          onChange={(nextValue, nextSelection) => {
            setDraft(nextValue);
            controller.setControllerState((current) => ({
              ...current,
              selectionStart: nextSelection,
            }));
          }}
          onSelectionChange={(selectionStart) =>
            controller.setControllerState((current) => ({ ...current, selectionStart }))
          }
          onBlur={() => {
            if (skipBlurSaveRef.current) {
              skipBlurSaveRef.current = false;
              return;
            }
            void handleSave();
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
                  handleMentionSelect(
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
                  handleReferenceSelect(
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
                  handleTagSelect(
                    tagResults[controller.controllerState.tagActiveIndex] ?? tagResults[0],
                  ),
              })
            ) {
              return;
            }

            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              skipBlurSaveRef.current = true;
              setDraft(value);
              setEditing(false);
              event.currentTarget.blur();
            }
          }}
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
          onSelect={handleReferenceSelect}
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
          style={getTodoEditorPickerPosition(editorRef.current)}
          onHoverIndex={(mentionActiveIndex) =>
            controller.setControllerState((current) => ({ ...current, mentionActiveIndex }))
          }
          onSelect={handleMentionSelect}
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
          style={getTodoEditorPickerPosition(editorRef.current)}
          onHoverIndex={(tagActiveIndex) =>
            controller.setControllerState((current) => ({ ...current, tagActiveIndex }))
          }
          onSelect={handleTagSelect}
        />
      </div>
    );
  }

  return (
    <div
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={editable ? value : undefined}
      className={cn(
        "todo-inline-content w-full bg-transparent text-body font-medium leading-6 text-text whitespace-pre-wrap break-words",
        savedPulse && "todo-inline-content--saved",
      )}
      onClick={() => {
        if (editable) {
          setEditing(true);
        }
      }}
      onKeyDown={(event) => {
        if (!editable) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setEditing(true);
        }
      }}
    >
      <InternalReferenceInlineText
        value={value}
        variant="todo-inline"
        onOpenInternalReference={onOpenInternalReference}
        onOpenContactMention={onOpenContactMention ?? contactMentionOptions.onOpenContact}
      />
    </div>
  );
}
