import { useRef } from "react";

import type { ContactRecord, InternalReferenceContext } from "../../lib/types";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { ContactMentionPicker, useContactMentionSearch } from "../contact";
import {
  InternalReferencePicker,
  useInternalReferenceSearch,
} from "../internal-reference";
import { TagMentionPicker, useTagMentionSearch } from "../tags/TagMentionPicker";
import { TodoReferenceEditor } from "./TodoReferenceEditor";
import {
  focusTodoEditorInput,
  getTodoEditorPickerPosition,
  handleTodoEditorMentionKeyDown,
  handleTodoEditorReferenceKeyDown,
  handleTodoEditorTagKeyDown,
  insertInternalReferenceToken,
  insertMentionToken,
  insertTagToken,
  useSyncTodoEditorPickerState,
  useTodoEditorController,
} from "./todo-editor-controller";

interface TodoProgressTextEditorProps {
  value: string;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  internalReferenceContext?: InternalReferenceContext | null;
  normalizeValue?: (value: string) => string;
  disableMentionTrigger?: (trigger: { start: number; end: number }) => boolean;
  onChange: (nextValue: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function TodoProgressTextEditor({
  value,
  autoFocus = false,
  disabled = false,
  placeholder = "@0315 已与财务确认方案",
  internalReferenceContext,
  normalizeValue = normalizeProgressDraft,
  disableMentionTrigger,
  onChange,
  onCommit,
  onCancel,
}: TodoProgressTextEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const skipBlurRef = useRef(false);
  const contactMentionOptions = useContactMentionOptions();
  const controller = useTodoEditorController({
    draft: value,
    editing: true,
    internalReferenceContext,
    disableMentionTrigger,
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
  const mentionOptionCount = mentionResults.length + (controller.mentionCreatable ? 1 : 0);
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

  function handleReferenceInsert(reference: Parameters<typeof insertInternalReferenceToken>[2]) {
    if (!controller.referenceTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertInternalReferenceToken(
      value,
      controller.referenceTrigger,
      reference,
    );
    onChange(normalizeValue(nextValue));
    controller.setControllerState((current) => ({
      ...current,
      selectionStart: nextSelection,
      dismissedTriggerKey: null,
    }));
    focusTodoEditorInput(editorRef.current);
  }

  function handleMentionInsert(contact: ContactRecord) {
    if (!controller.mentionTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertMentionToken(
      value,
      controller.mentionTrigger,
      contact,
    );
    onChange(normalizeValue(nextValue));
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

      const { nextValue, nextSelection } = insertMentionToken(value, trigger, target);
      onChange(normalizeValue(nextValue));
      controller.setControllerState((current) => ({
        ...current,
        selectionStart: nextSelection,
        dismissedMentionKey: controller.mentionTriggerKey,
      }));
      focusTodoEditorInput(editorRef.current);
    });
  }

  function handleTagInsert(tag: Parameters<typeof insertTagToken>[2]) {
    if (!controller.tagTrigger) {
      return;
    }

    const { nextValue, nextSelection } = insertTagToken(value, controller.tagTrigger, tag);
    onChange(normalizeValue(nextValue));
    controller.setControllerState((current) => ({
      ...current,
      selectionStart: nextSelection,
      dismissedTagKey: controller.tagTriggerKey,
    }));
    focusTodoEditorInput(editorRef.current);
  }

  return (
    <div className="relative">
      <TodoReferenceEditor
        editorRef={editorRef}
        value={value}
        selectionOffset={controller.controllerState.selectionStart}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        textClassName="text-ui leading-[1.2rem]"
        onChange={(nextValue, nextSelection) => {
          onChange(normalizeValue(nextValue));
          controller.setControllerState((current) => ({
            ...current,
            selectionStart: nextSelection,
          }));
        }}
        onSelectionChange={(selectionStart) =>
          controller.setControllerState((current) => ({ ...current, selectionStart }))
        }
        onBlur={() => {
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            return;
          }
          onCommit();
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

          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }

          if (event.key === "Escape") {
            event.preventDefault();
            skipBlurRef.current = true;
            onCancel();
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
        style={getTodoEditorPickerPosition(editorRef.current)}
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
        style={getTodoEditorPickerPosition(editorRef.current)}
        onHoverIndex={(tagActiveIndex) =>
          controller.setControllerState((current) => ({ ...current, tagActiveIndex }))
        }
        onSelect={handleTagInsert}
      />
    </div>
  );
}

function normalizeProgressDraft(value: string) {
  return value.replace(/\r?\n+/gu, " ");
}
