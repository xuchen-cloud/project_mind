import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor, JSONContent } from "@tiptap/core";
import { DOMSerializer, type Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Bold,
  Code2,
  Columns2,
  Combine,
  Copy,
  ExternalLink,
  FolderOpen,
  Grid2X2Plus,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImageUp,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  LoaderCircle,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  PanelLeft,
  PanelTop,
  Pilcrow,
  Quote,
  Rows2,
  Scissors,
  Split,
  Strikethrough,
  Table2,
  TextSelect,
  Trash2,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";

import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import { isAiCapabilityConfigured, isAiCapabilityVisible } from "../../lib/ai";
import {
  buildContactMentionTarget,
  findContactMentionElement,
  findContactMentionTextTrigger,
  readContactMentionElement,
  setContactMentionElementBroken,
} from "../../lib/contactMentions";
import {
  aiEditorRewriteJobTargetKey,
  editorRewriteJobInput,
  ensureAiJobSync,
  readEditorRewriteJobResult,
  useAiJobTarget,
} from "../../lib/aiJobs";
import { fileUriToPath } from "../../lib/formatters";
import {
  buildInternalReferenceTarget,
  findInternalReferenceElement,
  findInternalReferenceTextTrigger,
  readInternalReferenceElement,
  setInternalReferenceElementBroken,
} from "../../lib/internalReferences";
import { repairRichTextAssetHtml, resolveRichTextImageSrc } from "../../lib/richTextAssets";
import { renderMarkdownToHtml, richTextHtmlToPlainText } from "../../lib/richTextContent";
import type {
  AiEditorRewriteContext,
  AiSettingsSnapshot,
  ContactRecord,
  InternalReferenceSearchResult,
} from "../../lib/types";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  ActionContextMenu,
  type ContextMenuAction,
  PopoverPanel,
  ToolbarButton,
} from "../../ui/components";
import {
  ContactMentionPicker,
  useContactMentionSearch,
} from "../contact";
import {
  InternalReferencePicker,
  useInternalReferenceSearch,
} from "../internal-reference";
import {
  buildEditorRewritePreviewHtml,
  type EditorRewriteBlockRange,
  buildEditorRewriteSelection,
  buildEditorRewriteSlice,
  type EditorRewritePlaceholder,
} from "./editorRewrite";
import { RichEditorAiMenu, type RichEditorAiMenuIconAction, type RichEditorAiMenuTextAction } from "./RichEditorAiMenu";
import { RichEditorRewriteWidget } from "./RichEditorRewriteWidget";
import { ImageAnnotationDialog } from "./ImageAnnotationDialog";
import { buildRichEditorExtensions } from "./extensions";
import { EMPTY_RICH_EDITOR_HTML, serializeEditorMarkdown } from "./markdown";
import { normalizeRichEditorValue } from "./normalize";
import type {
  RichEditorAsset,
  RichEditorAssetHandlers,
  RichEditorContactMentionOptions,
  RichEditorInternalReferenceOptions,
  RichEditorPersistState,
  RichEditorValue,
  RichEditorVariant,
} from "./types";

const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "heic",
  "heif",
  "avif",
];
const TABLE_INSERT_GRID_SIZE = 6;
const DEFAULT_TABLE_DIMENSIONS = { rows: 3, cols: 3 };
export const RICH_EDITOR_FOCUS_REQUEST_EVENT =
  "project-mind-rich-editor-focus-request";
const RICH_EDITOR_REWRITE_WIDGET_PLUGIN_KEY = new PluginKey(
  "project-mind-rich-editor-rewrite-widget",
);

type SaveReason =
  | "debounced"
  | "blur"
  | "manual"
  | "queued"
  | "window-blur"
  | "visibility-hidden";
type AutosaveConfig = {
  enabled: boolean;
  delay: number;
  saveOnChange: boolean;
  saveOnBlur: boolean;
  saveOnWindowBlur: boolean;
  saveOnVisibilityChange: boolean;
};

interface ToolbarItem {
  key: string;
  label: string;
  icon: typeof Pilcrow;
  isActive: () => boolean;
  isDisabled?: () => boolean;
  run: () => unknown;
  busy?: boolean;
}

interface EditorContextMenuState {
  x: number;
  y: number;
  ariaLabel: string;
  actions: ContextMenuAction[];
  autoFocus?: boolean;
}

interface EditorAiMenuState {
  x: number;
  y: number;
}

interface ImageContextMenuTarget {
  nodePos: number;
  attrs: {
    alt?: string;
    documentId?: number;
    mimeType?: string;
    path?: string;
    src?: string;
    title?: string;
    annotationState?: string | null;
    width?: number | null;
  };
}

interface ImageAnnotationDialogState {
  nodePos: number;
  title: string;
  imageSrc: string;
  annotationState?: string | null;
  imageSize?: {
    width?: number;
    height?: number;
  };
}

interface RichEditorAutoFocusPoint {
  x: number;
  y: number;
  mode?: "viewport" | "content-relative";
}

interface StoredTextSelection {
  from: number;
  to: number;
}

interface EditorRewriteSessionState {
  targetKey: string;
  actionId?: number | null;
  actionLabel: string;
  from: number;
  to: number;
  originalMarkdown: string;
  placeholders: EditorRewritePlaceholder[];
  blockRanges: EditorRewriteBlockRange[];
}

type EditorRewriteDisplayStatus = "queued" | "running" | "succeeded" | "failed";

interface EditorRewriteWidgetState {
  actionLabel: string;
  anchorPos: number;
  blockRanges: EditorRewriteBlockRange[];
  status: EditorRewriteDisplayStatus;
  previewHtml: string;
  errorMessage?: string | null;
}

interface RichEditorProps {
  html?: string;
  defaultHtml?: string;
  variant?: RichEditorVariant;
  placeholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean | RichEditorAutoFocusPoint;
  enableTables?: boolean;
  autosave?:
    | boolean
    | {
        delay?: number;
        onChange?: boolean;
        onBlur?: boolean;
        onWindowBlur?: boolean;
        onVisibilityChange?: boolean;
      };
  shouldPersistOnBlur?: (relatedTarget: EventTarget | null) => boolean;
  assetHandlers?: RichEditorAssetHandlers;
  onChange?: (value: RichEditorValue) => void;
  onSave?: (value: RichEditorValue) => Promise<unknown> | unknown;
  onPersistStateChange?: (state: RichEditorPersistState) => void;
  onBlurPersisted?: (result: unknown) => void;
  onModEnter?: () => Promise<unknown> | unknown;
  onOpenAsset?: (asset: RichEditorAsset) => void | Promise<void>;
  internalReferences?: RichEditorInternalReferenceOptions;
  contactMentions?: RichEditorContactMentionOptions;
  aiSettings?: AiSettingsSnapshot;
  aiRewriteContext?: AiEditorRewriteContext;
  onOpenAiSettings?: () => void;
  selectionActions?: RichEditorSelectionAction[];
  renderToolbarExtras?: (context: {
    persistState: RichEditorPersistState;
    save: (options?: { force?: boolean }) => Promise<unknown>;
  }) => ReactNode;
}

export interface RichEditorSelectionPayload {
  text: string;
  markdown: string;
  html: string;
}

export interface RichEditorSelectionAction {
  key: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  onSelect: (payload: RichEditorSelectionPayload) => Promise<unknown> | unknown;
}

export function RichEditor({
  html,
  defaultHtml,
  variant = "toolbar",
  placeholder = "输入内容，Markdown 会即时渲染为富文本。",
  readOnly = false,
  autoFocus = false,
  enableTables = true,
  autosave = false,
  shouldPersistOnBlur,
  assetHandlers,
  onChange,
  onSave,
  onPersistStateChange,
  onBlurPersisted,
  onModEnter,
  onOpenAsset,
  internalReferences,
  contactMentions,
  aiSettings,
  aiRewriteContext,
  onOpenAiSettings,
  selectionActions,
  renderToolbarExtras,
}: RichEditorProps) {
  const { pushToast } = useFeedbackStore();
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [isFocused, setIsFocused] = useState(false);
  const [assetBusy, setAssetBusy] = useState<null | "image" | "file">(null);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [aiMenu, setAiMenu] = useState<EditorAiMenuState | null>(null);
  const [annotationDialog, setAnnotationDialog] = useState<ImageAnnotationDialogState | null>(null);
  const [rewriteSession, setRewriteSession] = useState<EditorRewriteSessionState | null>(null);
  const [uiTick, setUiTick] = useState(0);
  const [referencePicker, setReferencePicker] = useState<null | {
    start: number;
    end: number;
    query: string;
    position: { left: number; top: number };
  }>(null);
  const [referenceActiveIndex, setReferenceActiveIndex] = useState(0);
  const [mentionPicker, setMentionPicker] = useState<null | {
    start: number;
    end: number;
    query: string;
    position: { left: number; top: number };
  }>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);

  const autosaveConfig = useMemo<AutosaveConfig>(() => {
    if (typeof autosave === "object") {
      return {
        enabled: true,
        delay: autosave.delay ?? 800,
        saveOnChange: autosave.onChange ?? true,
        saveOnBlur: autosave.onBlur ?? true,
        saveOnWindowBlur: autosave.onWindowBlur ?? false,
        saveOnVisibilityChange: autosave.onVisibilityChange ?? false,
      };
    }

    return {
      enabled: Boolean(autosave),
      delay: 800,
      saveOnChange: Boolean(autosave),
      saveOnBlur: Boolean(autosave),
      saveOnWindowBlur: false,
      saveOnVisibilityChange: false,
    };
  }, [autosave]);

  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const taskShortcutTransformRef = useRef(false);
  const autoFocusAppliedRef = useRef(false);
  const lastPersistedHtmlRef = useRef(normalizeHtml(html ?? defaultHtml));
  const lastResolvedHtmlRef = useRef(normalizeHtml(html ?? defaultHtml));
  const persistStateRef = useRef<RichEditorPersistState>("idle");
  const syntheticPasteRef = useRef(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const storedTextSelectionRef = useRef<StoredTextSelection | null>(null);
  const referencePickerRef = useRef<null | {
    start: number;
    end: number;
    query: string;
    position: { left: number; top: number };
  }>(null);
  const referenceActiveIndexRef = useRef(0);
  const referenceResultsRef = useRef<InternalReferenceSearchResult[]>([]);
  const mentionPickerRef = useRef<null | {
    start: number;
    end: number;
    query: string;
    position: { left: number; top: number };
  }>(null);
  const mentionActiveIndexRef = useRef(0);
  const mentionResultsRef = useRef<ContactRecord[]>([]);
  const rewriteWidgetStateRef = useRef<EditorRewriteWidgetState | null>(null);
  const rewriteWidgetCallbacksRef = useRef<{
    onAccept: () => void;
    onClose: () => void;
    onOpenAiSettings?: () => void;
  }>({
    onAccept: () => {},
    onClose: () => {},
    onOpenAiSettings: undefined,
  });
  const rewriteJob = useAiJobTarget(rewriteSession?.targetKey ?? "__rich-editor-rewrite-idle__");
  const enabledRewriteActions = useMemo(
    () => aiSettings?.editorRewriteActions.filter((action) => action.enabled) ?? [],
    [aiSettings?.editorRewriteActions],
  );
  const editorRewriteVisible = Boolean(aiSettings) && isAiCapabilityVisible(aiSettings, "editor_rewrite");
  const editorRewriteReady = Boolean(aiSettings) && isAiCapabilityConfigured(aiSettings, "editor_rewrite");
  const editorInteractionLocked = Boolean(rewriteSession);
  const effectiveReadOnly = readOnly || editorInteractionLocked;
  const rewritePreviewMarkdown =
    rewriteJob?.status === "succeeded"
      ? readEditorRewriteJobResult(rewriteJob).rewrittenMarkdown
      : rewriteJob?.streamText ?? "";
  const rewriteUnavailableReason = aiSettings?.aiSecretsUnlocked === false
    ? "需先解锁 AI 配置"
    : !editorRewriteReady
      ? "需先配置 AI 模型"
      : null;

  const rememberCurrentTextSelection = useCallback((nextEditor: Editor | null) => {
    if (!nextEditor) {
      storedTextSelectionRef.current = null;
      return;
    }

    const selection = nextEditor.state.selection;
    if (selection instanceof TextSelection && !selection.empty) {
      storedTextSelectionRef.current = {
        from: selection.from,
        to: selection.to,
      };
      return;
    }

    storedTextSelectionRef.current = null;
  }, []);

  const restoreStoredTextSelection = useCallback((nextEditor: Editor) => {
    const storedSelection = storedTextSelectionRef.current;

    if (!storedSelection) {
      return false;
    }

    try {
      nextEditor.view.dispatch(
        nextEditor.state.tr.setSelection(
          TextSelection.create(nextEditor.state.doc, storedSelection.from, storedSelection.to),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  const handlePastedImages = useCallback(
    async (view: EditorView, files: File[]) => {
      for (const file of files) {
        const imageAttrs = await buildPastedImageAttrs(file, assetHandlers);

        if (!imageAttrs) {
          continue;
        }

        focusEmptyEditorSelection(view);
        insertImageAtSelection(view, imageAttrs);
      }
    },
    [assetHandlers],
  );

  const handlePastedHtml = useCallback(
    async (view: EditorView, rawHtml: string) => {
      const nextHtml = await buildPastedHtml(rawHtml, assetHandlers);

      if (!nextHtml) {
        return;
      }

      focusEmptyEditorSelection(view);
      syntheticPasteRef.current = true;
      view.pasteHTML(nextHtml, createSyntheticPasteEvent());
    },
    [assetHandlers],
  );

  const { results: referenceResults, loading: referenceLoading } = useInternalReferenceSearch({
    open: Boolean(referencePicker),
    query: referencePicker?.query ?? "",
    context: internalReferences?.context,
    limit: 8,
  });

  const { results: mentionResults, loading: mentionLoading } = useContactMentionSearch({
    open: Boolean(mentionPicker),
    query: mentionPicker?.query ?? "",
    limit: 8,
  });

  referencePickerRef.current = referencePicker;
  referenceActiveIndexRef.current = referenceActiveIndex;
  referenceResultsRef.current = referenceResults;
  mentionPickerRef.current = mentionPicker;
  mentionActiveIndexRef.current = mentionActiveIndex;
  mentionResultsRef.current = mentionResults;

  const mentionsEnabled = Boolean(contactMentions);
  const mentionCreatable =
    mentionsEnabled &&
    Boolean(contactMentions?.onCreateContact) &&
    (mentionPicker?.query.trim().length ?? 0) > 0;
  // The create row, when present, sits just past the search hits.
  const mentionOptionCount = mentionResults.length + (mentionCreatable ? 1 : 0);

  const closeInternalReferencePicker = useCallback(() => {
    setReferencePicker(null);
    setReferenceActiveIndex(0);
  }, []);

  const syncInternalReferencePicker = useCallback(
    (nextEditor: Editor | null) => {
      if (!nextEditor || effectiveReadOnly || !internalReferences?.context) {
        closeInternalReferencePicker();
        return;
      }

      const nextTrigger = resolveEditorInternalReferenceTrigger(nextEditor, frameRef.current);

      setReferencePicker((current) => {
        if (!nextTrigger) {
          return null;
        }

        if (
          current &&
          current.start === nextTrigger.start &&
          current.end === nextTrigger.end &&
          current.query === nextTrigger.query &&
          current.position.left === nextTrigger.position.left &&
          current.position.top === nextTrigger.position.top
        ) {
          return current;
        }

        return nextTrigger;
      });
    },
    [closeInternalReferencePicker, effectiveReadOnly, internalReferences?.context],
  );

  const handleSelectInternalReference = useCallback(
    (view: EditorView, reference: InternalReferenceSearchResult) => {
      const trigger = referencePickerRef.current;
      const nodeType = view.state.schema.nodes.internalReference;

      if (!trigger || !nodeType) {
        return false;
      }

      const target = buildInternalReferenceTarget(reference);
      const referenceNode = nodeType.create({
        refKind: target.refKind,
        refId: target.refId,
        label: target.label,
      });
      const tr = view.state.tr.delete(trigger.start, trigger.end);

      tr.insert(trigger.start, referenceNode);

      const nextSelectionPos = trigger.start + referenceNode.nodeSize;
      tr.insertText(" ", nextSelectionPos);
      tr.setSelection(TextSelection.create(tr.doc, nextSelectionPos + 1));
      view.dispatch(tr.scrollIntoView());
      closeInternalReferencePicker();
      return true;
    },
    [closeInternalReferencePicker],
  );

  const closeContactMentionPicker = useCallback(() => {
    setMentionPicker(null);
    setMentionActiveIndex(0);
  }, []);

  const syncContactMentionPicker = useCallback(
    (nextEditor: Editor | null) => {
      if (!nextEditor || effectiveReadOnly || !contactMentions) {
        closeContactMentionPicker();
        return;
      }

      const nextTrigger = resolveEditorContactMentionTrigger(nextEditor, frameRef.current);

      setMentionPicker((current) => {
        if (!nextTrigger) {
          return null;
        }

        if (
          current &&
          current.start === nextTrigger.start &&
          current.end === nextTrigger.end &&
          current.query === nextTrigger.query &&
          current.position.left === nextTrigger.position.left &&
          current.position.top === nextTrigger.position.top
        ) {
          return current;
        }

        return nextTrigger;
      });
    },
    [closeContactMentionPicker, effectiveReadOnly, contactMentions],
  );

  const insertContactMentionNode = useCallback(
    (
      view: EditorView,
      trigger: { start: number; end: number },
      mention: { contactId: number; label: string },
    ) => {
      const nodeType = view.state.schema.nodes.contactMention;

      if (!nodeType) {
        return false;
      }

      const mentionNode = nodeType.create({
        contactId: mention.contactId,
        label: mention.label,
      });
      const tr = view.state.tr.delete(trigger.start, trigger.end);

      tr.insert(trigger.start, mentionNode);

      const nextSelectionPos = trigger.start + mentionNode.nodeSize;
      tr.insertText(" ", nextSelectionPos);
      tr.setSelection(TextSelection.create(tr.doc, nextSelectionPos + 1));
      view.dispatch(tr.scrollIntoView());
      closeContactMentionPicker();
      return true;
    },
    [closeContactMentionPicker],
  );

  const handleSelectContactMention = useCallback(
    (view: EditorView, contact: ContactRecord) => {
      const trigger = mentionPickerRef.current;

      if (!trigger) {
        return false;
      }

      const target = buildContactMentionTarget(contact);
      return insertContactMentionNode(view, trigger, target);
    },
    [insertContactMentionNode],
  );

  const handleCreateContactMention = useCallback(
    (view: EditorView, name: string) => {
      const trigger = mentionPickerRef.current;
      const createContact = contactMentions?.onCreateContact;

      if (!trigger || !createContact || !name.trim()) {
        return false;
      }

      void Promise.resolve(createContact(name.trim())).then((target) => {
        if (target) {
          insertContactMentionNode(view, trigger, buildContactMentionTarget(target));
        }
      });
      // Optimistically close so the editor regains a clean state while the
      // contact is being created.
      closeContactMentionPicker();
      return true;
    },
    [closeContactMentionPicker, contactMentions?.onCreateContact, insertContactMentionNode],
  );

  useEffect(() => {
    if (!mentionPicker) {
      return;
    }

    setMentionActiveIndex((current) => {
      if (mentionOptionCount === 0) {
        return 0;
      }

      return Math.min(current, mentionOptionCount - 1);
    });
  }, [mentionOptionCount, mentionPicker]);

  useEffect(() => {
    if (!mentionPicker) {
      return;
    }

    setMentionActiveIndex(0);
  }, [mentionPicker?.query]);

  useEffect(() => {
    if (!referencePicker) {
      return;
    }

    setReferenceActiveIndex((current) => {
      if (referenceResults.length === 0) {
        return 0;
      }

      return Math.min(current, referenceResults.length - 1);
    });
  }, [referencePicker, referenceResults.length]);

  useEffect(() => {
    if (!referencePicker) {
      return;
    }

    setReferenceActiveIndex(0);
  }, [referencePicker?.query]);

  const updatePersistState = useCallback(
    (nextState: RichEditorPersistState) => {
      persistStateRef.current = nextState;
      setPersistState(nextState);
      onPersistStateChange?.(nextState);
    },
    [onPersistStateChange],
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: !effectiveReadOnly,
    extensions: buildRichEditorExtensions(placeholder),
    content: normalizeHtml(html ?? defaultHtml),
    editorProps: {
      attributes: {
        class: "rich-editor__surface",
      },
      clipboardTextSerializer: (content, view) => serializeRichTextClipboard(content, view),
      transformPastedHTML: (rawHtml) => sanitizePastedHtml(rawHtml),
      handlePaste: (view, event) => {
        if (syntheticPasteRef.current) {
          syntheticPasteRef.current = false;
          return false;
        }

        if (effectiveReadOnly) {
          return false;
        }

        const imageFiles = extractClipboardImageFiles(event.clipboardData);

        if (imageFiles.length > 0) {
          event.preventDefault();
          void handlePastedImages(view, imageFiles).catch(() => {
            // The caller owns error presentation.
          });
          return true;
        }

        const rawHtml = event.clipboardData?.getData("text/html") ?? "";
        const rawText = event.clipboardData?.getData("text/plain") ?? "";

        if (!rawHtml && shouldHandlePastedMarkdown(rawText)) {
          event.preventDefault();
          syntheticPasteRef.current = true;
          view.pasteHTML(renderMarkdownToHtml(rawText), createSyntheticPasteEvent());
          return true;
        }

        if (!shouldHandlePastedHtml(rawHtml, { allowTables: enableTables })) {
          return false;
        }

        event.preventDefault();
        void handlePastedHtml(view, rawHtml).catch(() => {
          const fallbackHtml = sanitizePastedHtml(rawHtml);

          if (!fallbackHtml) {
            return;
          }

          syntheticPasteRef.current = true;
          view.pasteHTML(fallbackHtml, createSyntheticPasteEvent());
        });
        return true;
      },
      handleKeyDown: (_view, event) => {
        const activeReferencePicker = referencePickerRef.current;

        if (!effectiveReadOnly && activeReferencePicker) {
          if (event.key === "Escape") {
            event.preventDefault();
            closeInternalReferencePicker();
            return true;
          }

          if (event.key === "ArrowDown") {
            event.preventDefault();
            setReferenceActiveIndex((current) => {
              if (referenceResultsRef.current.length === 0) {
                return 0;
              }

              return (current + 1) % referenceResultsRef.current.length;
            });
            return true;
          }

          if (event.key === "ArrowUp") {
            event.preventDefault();
            setReferenceActiveIndex((current) => {
              if (referenceResultsRef.current.length === 0) {
                return 0;
              }

              return current === 0
                ? referenceResultsRef.current.length - 1
                : current - 1;
            });
            return true;
          }

          if (event.key === "Enter" && referenceResultsRef.current.length > 0) {
            event.preventDefault();
            return handleSelectInternalReference(
              _view,
              referenceResultsRef.current[
                Math.max(
                  0,
                  Math.min(
                    referenceActiveIndexRef.current,
                    referenceResultsRef.current.length - 1,
                  ),
                )
              ],
            );
          }
        }

        const activeMentionPicker = mentionPickerRef.current;

        if (!effectiveReadOnly && activeMentionPicker) {
          const mentionCount = mentionResultsRef.current.length;
          const createName = activeMentionPicker.query.trim();
          const hasCreateRow =
            Boolean(contactMentions?.onCreateContact) && createName.length > 0;
          const optionCount = mentionCount + (hasCreateRow ? 1 : 0);

          if (event.key === "Escape") {
            event.preventDefault();
            closeContactMentionPicker();
            return true;
          }

          if (event.key === "ArrowDown" && optionCount > 0) {
            event.preventDefault();
            setMentionActiveIndex((current) => (current + 1) % optionCount);
            return true;
          }

          if (event.key === "ArrowUp" && optionCount > 0) {
            event.preventDefault();
            setMentionActiveIndex((current) =>
              current === 0 ? optionCount - 1 : current - 1,
            );
            return true;
          }

          if (event.key === "Enter" && optionCount > 0) {
            event.preventDefault();
            const activeIndex = Math.max(
              0,
              Math.min(mentionActiveIndexRef.current, optionCount - 1),
            );

            if (hasCreateRow && activeIndex === mentionCount) {
              return handleCreateContactMention(_view, createName);
            }

            return handleSelectContactMention(
              _view,
              mentionResultsRef.current[activeIndex],
            );
          }
        }

        if (
          onModEnter &&
          !effectiveReadOnly &&
          !event.isComposing &&
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          void Promise.resolve(onModEnter()).catch(() => {
            // The caller owns error presentation.
          });
          return true;
        }

        if (
          !effectiveReadOnly &&
          event.key === "Tab" &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey
        ) {
          const chain = editor?.chain().focus();
          const handled = event.shiftKey
            ? Boolean(chain?.liftListItem("taskItem").run() || chain?.liftListItem("listItem").run())
            : Boolean(chain?.sinkListItem("taskItem").run() || chain?.sinkListItem("listItem").run());

          if (handled) {
            event.preventDefault();
            return true;
          }
        }

        return false;
      },
    },
    onCreate: () => {
      updatePersistState("idle");
    },
    onFocus: ({ editor: nextEditor }) => {
      setIsFocused(true);
      setUiTick((tick) => tick + 1);
      rememberCurrentTextSelection(nextEditor);
      syncInternalReferencePicker(nextEditor);
      syncContactMentionPicker(nextEditor);
    },
    onBlur: () => {
      setIsFocused(false);
      setUiTick((tick) => tick + 1);
      closeInternalReferencePicker();
      closeContactMentionPicker();
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      setUiTick((tick) => tick + 1);
      rememberCurrentTextSelection(nextEditor);
      syncInternalReferencePicker(nextEditor);
      syncContactMentionPicker(nextEditor);
    },
    onUpdate: ({ editor: nextEditor }) => {
      if (taskShortcutTransformRef.current) {
        taskShortcutTransformRef.current = false;
      } else if (applyTaskListMarkdownShortcut(nextEditor)) {
        taskShortcutTransformRef.current = true;
        return;
      }

      const snapshot = serializeEditor(nextEditor);

      onChange?.(snapshot);
      setUiTick((tick) => tick + 1);
      syncInternalReferencePicker(nextEditor);
      syncContactMentionPicker(nextEditor);

      if (snapshot.html !== lastPersistedHtmlRef.current) {
        updatePersistState("dirty");
      } else if (persistStateRef.current !== "saving") {
        updatePersistState("saved");
      }
    },
  });

  const rewritePreviewHtml = useMemo(() => {
    if (!editor || !rewriteSession) {
      return "";
    }

    try {
      return buildEditorRewritePreviewHtml(
        editor,
        rewritePreviewMarkdown,
        rewriteSession.placeholders,
      );
    } catch {
      return "";
    }
  }, [editor, rewritePreviewMarkdown, rewriteSession]);
  const rewriteDisplayStatus: EditorRewriteDisplayStatus = rewriteSession
    ? rewriteJob?.status ?? "queued"
    : "queued";
  const rewriteWidgetState = useMemo<EditorRewriteWidgetState | null>(() => {
    if (!rewriteSession) {
      return null;
    }

    return {
      actionLabel: rewriteSession.actionLabel,
      anchorPos: rewriteSession.to,
      blockRanges: rewriteSession.blockRanges,
      status: rewriteDisplayStatus,
      previewHtml: rewritePreviewHtml,
      errorMessage: rewriteJob?.errorMessage ?? null,
    };
  }, [rewriteDisplayStatus, rewriteJob?.errorMessage, rewritePreviewHtml, rewriteSession]);

  rewriteWidgetStateRef.current = rewriteWidgetState;

  useEffect(() => {
    if (!editor) {
      return undefined;
    }

    const handleSelectionChange = () => {
      const selection = readDomTextSelection(editor);
      if (selection) {
        storedTextSelectionRef.current = selection;
      }
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.view.dispatch(
      editor.state.tr.setMeta(RICH_EDITOR_REWRITE_WIDGET_PLUGIN_KEY, Date.now()),
    );
  }, [editor, rewriteWidgetState, uiTick]);

  const clearPersistTimer = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const persistEditor = useCallback(
    async (reason: SaveReason, options?: { force?: boolean }) => {
      if (!editor || !onSave || readOnly) {
        return undefined;
      }

      clearPersistTimer();

      const snapshot = normalizeRichEditorValue(serializeEditor(editor));

      if (snapshot.html !== normalizeHtml(editor.getHTML())) {
        editor.commands.setContent(snapshot.html, {
          emitUpdate: false,
        });
      }

      if (snapshot.html === lastPersistedHtmlRef.current && !options?.force) {
        updatePersistState(snapshot.html === EMPTY_RICH_EDITOR_HTML ? "idle" : "saved");
        return undefined;
      }

      if (saveInFlightRef.current) {
        saveQueuedRef.current = true;
        return undefined;
      }

      saveInFlightRef.current = true;
      updatePersistState("saving");

      try {
        const result = await onSave(snapshot);
        lastPersistedHtmlRef.current = snapshot.html;
        lastResolvedHtmlRef.current = snapshot.html;
        updatePersistState(snapshot.html === EMPTY_RICH_EDITOR_HTML ? "idle" : "saved");
        return result;
      } catch (error) {
        updatePersistState("error");
        throw error;
      } finally {
        saveInFlightRef.current = false;

        if (
          saveQueuedRef.current ||
          reason === "blur" ||
          reason === "window-blur" ||
          reason === "visibility-hidden"
        ) {
          saveQueuedRef.current = false;
          const latestSnapshot = serializeEditor(editor);

          if (latestSnapshot.html !== lastPersistedHtmlRef.current) {
            void persistEditor("queued").catch(() => {
              // The caller owns error presentation.
            });
          }
        }
      }
    },
    [clearPersistTimer, editor, onSave, readOnly, updatePersistState],
  );

  const schedulePersist = useCallback(() => {
    if (!autosaveConfig.enabled || !onSave || readOnly) {
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      void persistEditor("debounced").catch(() => {
        // The caller owns error presentation.
      });
    }, autosaveConfig.delay);
  }, [autosaveConfig.delay, autosaveConfig.enabled, onSave, persistEditor, readOnly]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const nextHtml = normalizeHtml(html ?? defaultHtml);

    if (nextHtml === lastResolvedHtmlRef.current) {
      return;
    }

    lastResolvedHtmlRef.current = nextHtml;
    lastPersistedHtmlRef.current = nextHtml;

    if (normalizeHtml(editor.getHTML()) !== nextHtml) {
      editor.commands.setContent(nextHtml, {
        emitUpdate: false,
      });
    }

    updatePersistState(nextHtml === EMPTY_RICH_EDITOR_HTML ? "idle" : "saved");
  }, [defaultHtml, editor, html, updatePersistState]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.setEditable(!effectiveReadOnly);
  }, [editor, effectiveReadOnly]);

  useEffect(() => {
    syncInternalReferencePicker(editor ?? null);
    syncContactMentionPicker(editor ?? null);
  }, [editor, syncInternalReferencePicker, syncContactMentionPicker]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const editorDom = editor.view.dom;
    const handleFocusRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{ position?: "start" | "end" }>;
      editor.commands.focus(customEvent.detail?.position ?? "end");
    };

    editorDom.addEventListener(
      RICH_EDITOR_FOCUS_REQUEST_EVENT,
      handleFocusRequest,
    );
    return () => {
      editorDom.removeEventListener(
        RICH_EDITOR_FOCUS_REQUEST_EVENT,
        handleFocusRequest,
      );
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || effectiveReadOnly || !autoFocus || autoFocusAppliedRef.current) {
      return;
    }

    autoFocusAppliedRef.current = true;
    focusEditorForAutoFocus(editor, autoFocus);

    let secondFrameId: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      focusEditorForAutoFocus(editor, autoFocus);
      secondFrameId = window.requestAnimationFrame(() => {
        focusEditorForAutoFocus(editor, autoFocus);
      });
    });
    const timeoutId = window.setTimeout(() => {
      focusEditorForAutoFocus(editor, autoFocus);
    }, 96);

    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
      }
      window.clearTimeout(timeoutId);
    };
  }, [autoFocus, editor, effectiveReadOnly]);

  useEffect(() => {
    if (!editor || !autosaveConfig.enabled || !autosaveConfig.saveOnChange || !onSave || readOnly) {
      return;
    }

    if (persistState === "dirty") {
      schedulePersist();
    }
  }, [
    autosaveConfig.enabled,
    autosaveConfig.saveOnChange,
    editor,
    onSave,
    persistState,
    readOnly,
    schedulePersist,
  ]);

  const persistForLifecycleChange = useCallback(
    (reason: "window-blur" | "visibility-hidden") => {
      if (!autosaveConfig.enabled || !onSave || readOnly) {
        return;
      }

      if (persistStateRef.current === "dirty" || persistStateRef.current === "saving") {
        void persistEditor(reason).catch(() => {
          // The caller owns error presentation.
        });
      }
    },
    [autosaveConfig.enabled, onSave, persistEditor, readOnly],
  );

  useEffect(() => {
    if (
      !editor ||
      !autosaveConfig.enabled ||
      (!autosaveConfig.saveOnWindowBlur && !autosaveConfig.saveOnVisibilityChange) ||
      !onSave ||
      readOnly
    ) {
      return;
    }

    const handleWindowBlur = () => {
      if (!autosaveConfig.saveOnWindowBlur) {
        return;
      }

      persistForLifecycleChange("window-blur");
    };

    const handleVisibilityChange = () => {
      if (!autosaveConfig.saveOnVisibilityChange || document.visibilityState !== "hidden") {
        return;
      }

      persistForLifecycleChange("visibility-hidden");
    };

    // `pagehide` is the most reliable "the page is going away" signal — it
    // fires on app/window close and webview teardown when `blur` /
    // `visibilitychange` may not. Treat it like a visibility-hidden flush so
    // unsaved edits survive lock / sleep / quit.
    const handlePageHide = () => {
      persistForLifecycleChange("visibility-hidden");
    };

    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    autosaveConfig.enabled,
    autosaveConfig.saveOnVisibilityChange,
    autosaveConfig.saveOnWindowBlur,
    editor,
    onSave,
    persistForLifecycleChange,
    readOnly,
  ]);

  useEffect(() => {
    return () => {
      clearPersistTimer();
    };
  }, [clearPersistTimer]);

  const handleBlur = useCallback(async (relatedTarget: EventTarget | null) => {
    if (!autosaveConfig.enabled || !autosaveConfig.saveOnBlur || !onSave || readOnly) {
      return;
    }

    if (shouldPersistOnBlur && !shouldPersistOnBlur(relatedTarget)) {
      return;
    }

    if (
      (autosaveConfig.saveOnWindowBlur || autosaveConfig.saveOnVisibilityChange) &&
      (document.visibilityState !== "visible" || !document.hasFocus())
    ) {
      return;
    }

    try {
      const result = await persistEditor("blur");
      onBlurPersisted?.(result);
    } catch {
      // The activity page handles error feedback with a toast.
    }
  }, [
    autosaveConfig.enabled,
    autosaveConfig.saveOnBlur,
    autosaveConfig.saveOnVisibilityChange,
    autosaveConfig.saveOnWindowBlur,
    onBlurPersisted,
    onSave,
    persistEditor,
    readOnly,
    shouldPersistOnBlur,
  ]);

  const handleManualSave = useCallback(async (options?: { force?: boolean }) => {
    if (!onSave || readOnly) {
      return undefined;
    }

    return persistEditor("manual", options);
  }, [onSave, persistEditor, readOnly]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const insertTable = useCallback((rows = DEFAULT_TABLE_DIMENSIONS.rows, cols = DEFAULT_TABLE_DIMENSIONS.cols) => {
    if (!editor) {
      return;
    }

    editor
      .chain()
      .focus()
      .command(ensureInsertionCursor)
      .insertTable({ rows, cols, withHeaderRow: true })
      .run();
  }, [editor]);

  const handleInsertImage = useCallback(async () => {
    if (!editor || !assetHandlers?.insertImage || readOnly) {
      return;
    }

    setAssetBusy("image");

    try {
      const sourcePath = await pickPath({
        title: "选择图片",
        filters: [
          {
            name: "Images",
            extensions: IMAGE_EXTENSIONS,
          },
        ],
      });

      if (!sourcePath) {
        return;
      }

      const asset = await assetHandlers.insertImage(sourcePath);
      const src = await resolveStoredImageSrc(asset);

      if (!src) {
        return;
      }

      insertObjectBlock(editor, {
        type: "image",
        attrs: {
          src,
          alt: asset.title,
          title: asset.title,
          path: asset.path,
          mimeType: asset.mimeType,
          documentId: asset.documentId,
        },
      });
    } finally {
      setAssetBusy(null);
    }
  }, [assetHandlers, editor, readOnly]);

  const handleInsertFile = useCallback(async () => {
    if (!editor || !assetHandlers?.insertFile || readOnly) {
      return;
    }

    setAssetBusy("file");

    try {
      const sourcePath = await pickPath({
        title: "选择文件",
      });

      if (!sourcePath) {
        return;
      }

      const asset = await assetHandlers.insertFile(sourcePath);

      insertObjectBlock(editor, {
        type: "attachment",
        attrs: {
          title: asset.title,
          href: asset.href ?? asset.path ?? "#",
          path: asset.path,
          mimeType: asset.mimeType,
          documentId: asset.documentId,
          meta: asset.meta,
        },
      });
    } finally {
      setAssetBusy(null);
    }
  }, [assetHandlers, editor, readOnly]);

  const handleFrameClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const internalReferenceElement = findInternalReferenceElement(event.target);

      if (internalReferenceElement) {
        event.preventDefault();
        event.stopPropagation();

        const reference = readInternalReferenceElement(internalReferenceElement);

        if (reference && internalReferences?.onOpenReference) {
          void Promise.resolve(internalReferences.onOpenReference(reference)).then((opened) => {
            setInternalReferenceElementBroken(internalReferenceElement, !opened);
          });
        }

        return;
      }

      const contactMentionElement = findContactMentionElement(event.target);

      if (contactMentionElement) {
        event.preventDefault();
        event.stopPropagation();

        const mention = readContactMentionElement(contactMentionElement);

        if (mention && contactMentions?.onOpenContact) {
          void Promise.resolve(contactMentions.onOpenContact(mention)).then((opened) => {
            setContactMentionElementBroken(contactMentionElement, !opened);
          });
        }

        return;
      }

      if (!onOpenAsset) {
        return;
      }

      const target = event.target as HTMLElement;
      const clickable = target.closest<HTMLElement>("[data-rich-editor-openable='true']");
      const attachment = target.closest<HTMLElement>("[data-type='attachment']");

      if (!clickable || !attachment) {
        return;
      }

      event.preventDefault();

      const title = attachment.dataset.title?.trim() || "未命名文件";
      const href = attachment.dataset.href || undefined;
      const path = attachment.dataset.path || undefined;
      const mimeType = attachment.dataset.mimeType || undefined;
      const documentId = attachment.dataset.documentId
        ? Number(attachment.dataset.documentId)
        : undefined;
      const meta = attachment.dataset.meta || undefined;

      void Promise.resolve(
        onOpenAsset({
          kind: "file",
          title,
          href,
          path,
          mimeType,
          documentId,
          meta,
        }),
      ).catch(() => {
        // The caller owns error presentation.
      });
    },
    [
      internalReferences?.onOpenReference,
      contactMentions?.onOpenContact,
      onOpenAsset,
    ],
  );

  const openImageAnnotationDialog = useCallback(
    (imageTarget: ImageContextMenuTarget, target?: Element | null) => {
      const imageSrc = resolveRichTextImageSrc(imageTarget.attrs.path, imageTarget.attrs.src);

      if (!imageSrc) {
        return;
      }

      const imageElement =
        target instanceof HTMLImageElement && target.matches("img.rich-editor__image")
          ? target
          : target?.closest<HTMLElement>(".rich-editor__image-node")?.querySelector<HTMLImageElement>(
              "img.rich-editor__image",
            ) ??
            null;

      setAnnotationDialog({
        nodePos: imageTarget.nodePos,
        title: imageTarget.attrs.title?.trim() || imageTarget.attrs.alt?.trim() || "图片浏览",
        imageSrc,
        annotationState: imageTarget.attrs.annotationState,
        imageSize:
          imageElement && (imageElement.naturalWidth > 0 || imageElement.naturalHeight > 0)
            ? {
                width: imageElement.naturalWidth || undefined,
                height: imageElement.naturalHeight || undefined,
              }
            : undefined,
      });
    },
    [],
  );

  const handleAnnotationSave = useCallback(
    (nextAnnotationState: string | null) => {
      if (!editor || !annotationDialog) {
        return;
      }

      updateImageNodeAttrs(editor, annotationDialog.nodePos, {
        annotationState: nextAnnotationState,
      });
      setAnnotationDialog(null);
    },
    [annotationDialog, editor],
  );

  const handleEditorDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!editor) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;

      if (target?.closest(".rich-editor__image-resize-handle")) {
        return;
      }

      const imageTarget = resolveImageContextMenuTarget(editor, target);

      if (!imageTarget) {
        return;
      }

      event.preventDefault();
      selectImageNode(editor, imageTarget.nodePos);
      openImageAnnotationDialog(imageTarget, target);
    },
    [editor, openImageAnnotationDialog],
  );

  const editorHasTableSelection = useMemo(
    () => Boolean(editor && !effectiveReadOnly && editor.isEditable && editor.isActive("table")),
    [editor, effectiveReadOnly, uiTick],
  );

  const tableToolbarGroups = useMemo(() => {
    if (!enableTables || !editor || !editorHasTableSelection) {
      return [] as ToolbarItem[][];
    }
    return buildTableToolbarGroups(editor, effectiveReadOnly);
  }, [editor, editorHasTableSelection, effectiveReadOnly, enableTables, uiTick]);

  const closeRewriteSession = useCallback(() => {
    setRewriteSession(null);
  }, []);

  const closeAiMenu = useCallback(() => {
    setAiMenu(null);
  }, []);

  const startEditorRewrite = useCallback(
    async (options: {
      actionId?: number | null;
      actionLabel: string;
      promptOverride?: string | null;
    }) => {
      if (!editor) {
        return;
      }

      if (rewriteUnavailableReason) {
        onOpenAiSettings?.();
        pushToast({
          tone: "error",
          title: "AI 改写暂不可用",
          detail:
            rewriteUnavailableReason === "需先解锁 AI 配置"
              ? "请先解锁 AI 配置，再运行编辑改写动作。"
              : "请先在 AI 设置里完成编辑改写能力绑定。",
        });
        return;
      }

      restoreStoredTextSelection(editor);
      const selection = buildEditorRewriteSelection(editor);
      if (!selection) {
        return;
      }

      const targetKey = aiEditorRewriteJobTargetKey(
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );

      setRewriteSession({
        targetKey,
        actionId: options.actionId ?? null,
        actionLabel: options.actionLabel,
        from: selection.from,
        to: selection.to,
        originalMarkdown: selection.expandedMarkdown,
        placeholders: selection.placeholders,
        blockRanges: selection.blockRanges,
      });
      setAiMenu(null);
      setContextMenu(null);

      try {
        await ensureAiJobSync();
        await projectMindApi.aiJobEnqueue(
          editorRewriteJobInput(targetKey, {
            actionId: options.actionId ?? null,
            promptOverride: options.promptOverride ?? null,
            selectedText: selection.selectedText,
            expandedMarkdown: selection.expandedMarkdown,
            placeholderTokens: selection.placeholders.map((item) => item.token),
            context: aiRewriteContext,
          }),
        );
      } catch (error) {
        setRewriteSession(null);
        pushToast({
          tone: "error",
          title: "AI 改写失败",
          detail: error instanceof Error ? error.message : "启动改写任务失败",
        });
      }
    },
    [
      aiRewriteContext,
      editor,
      onOpenAiSettings,
      pushToast,
      restoreStoredTextSelection,
      rewriteUnavailableReason,
    ],
  );

  const runEditorRewriteAction = useCallback(
    (actionId: number, actionLabel: string) => {
      void startEditorRewrite({
        actionId,
        actionLabel,
        promptOverride: null,
      });
    },
    [startEditorRewrite],
  );

  const runEditorRewritePrompt = useCallback(
    (promptOverride: string) => {
      void startEditorRewrite({
        actionId: null,
        actionLabel: "AI 编辑",
        promptOverride,
      });
    },
    [startEditorRewrite],
  );

  const applyRewriteResult = useCallback(
    () => {
      if (!editor || !rewriteSession || rewriteJob?.status !== "succeeded") {
        return;
      }

      try {
        const rewrite = readEditorRewriteJobResult(rewriteJob);
        const slice = buildEditorRewriteSlice(
          editor,
          rewrite.rewrittenMarkdown,
          rewriteSession.placeholders,
        );
        const tr = editor.state.tr;

        tr.replaceRange(rewriteSession.from, rewriteSession.to, slice);
        editor.view.dispatch(tr.scrollIntoView());
        setRewriteSession(null);
      } catch (error) {
        pushToast({
          tone: "error",
          title: "应用 AI 改写失败",
          detail: error instanceof Error ? error.message : "改写结果无法写回编辑器",
        });
      }
    },
    [editor, pushToast, rewriteJob, rewriteSession],
  );

  rewriteWidgetCallbacksRef.current = {
    onAccept: () => {
      applyRewriteResult();
    },
    onClose: () => {
      closeRewriteSession();
    },
    onOpenAiSettings,
  };

  useEffect(() => {
    if (!editor) {
      return;
    }

    const plugin = createEditorRewriteWidgetPlugin({
      getWidgetState: () => rewriteWidgetStateRef.current,
      getCallbacks: () => rewriteWidgetCallbacksRef.current,
    });

    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(RICH_EDITOR_REWRITE_WIDGET_PLUGIN_KEY);
    };
  }, [editor]);

  const handleEditorContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!editor || editorInteractionLocked) {
        return;
      }

      if (shouldIgnoreRichEditorContextMenuTarget(event.target)) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const hasTextSelection =
        syncDomTextSelectionToEditor(editor) ||
        syncStoredTextSelectionToEditor(editor, storedTextSelectionRef.current, {
          coords: {
            left: event.clientX,
            top: event.clientY,
          },
          target,
        }) ||
        hasExpandedTextSelection(editor);

      const imageTarget = !hasTextSelection ? resolveImageContextMenuTarget(editor, target) : null;

      if (imageTarget) {
        selectImageNode(editor, imageTarget.nodePos);
        event.preventDefault();
        setAiMenu(null);
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          ariaLabel: "图片操作",
          actions: buildImageContextMenuActions({
            editor,
            imageTarget,
            onBrowseImage: (targetElement) => openImageAnnotationDialog(imageTarget, targetElement),
            readOnly: effectiveReadOnly,
          }),
          autoFocus: false,
        });
        return;
      }

      if (!hasTextSelection && enableTables) {
        const tableFocusPos = resolveTableFocusPos(editor, target);

        if (typeof tableFocusPos === "number") {
          focusTableAtPos(editor, tableFocusPos);
          event.preventDefault();
          setAiMenu(null);
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            ariaLabel: "表格操作",
            actions: buildTableContextMenuActions(
              buildTableToolbarGroups(editor, effectiveReadOnly),
            ),
            autoFocus: false,
          });
          return;
        }
      }

      const proseMirrorTarget = target?.closest(".ProseMirror");
      if (proseMirrorTarget) {
        event.preventDefault();
        const selectionPayload =
          hasTextSelection && selectionActions && selectionActions.length > 0
            ? buildRichEditorSelectionPayload(editor)
            : null;

        if (selectionPayload && selectionActions && selectionActions.length > 0) {
          setAiMenu(null);
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            ariaLabel: "选区操作",
            actions: buildSelectionContextMenuActions({
              editor,
              readOnly: effectiveReadOnly,
              selectionActions,
              selectionPayload,
            }),
            autoFocus: false,
          });
          return;
        }

        if (hasTextSelection && editorRewriteVisible && !effectiveReadOnly) {
          setContextMenu(null);
          setAiMenu({
            x: event.clientX,
            y: event.clientY,
          });
          return;
        }

        setAiMenu(null);
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          ariaLabel: "文本操作",
          actions: buildTextContextMenuActions(editor, effectiveReadOnly, enableTables ? insertTable : undefined),
          autoFocus: false,
        });
        return;
      }

      setContextMenu(null);
      setAiMenu(null);
    },
    [
      editor,
      editorInteractionLocked,
      editorRewriteVisible,
      effectiveReadOnly,
      enableTables,
      onOpenAiSettings,
      openImageAnnotationDialog,
      runEditorRewriteAction,
      selectionActions,
    ],
  );

  const handleFramePointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        !editor ||
        effectiveReadOnly ||
        !(event.target instanceof HTMLElement)
      ) {
        return;
      }

      if (
        isContextMenuPointerTrigger(event.button, event.ctrlKey) &&
        storedTextSelectionRef.current &&
        event.target.closest(".ProseMirror")
      ) {
        event.preventDefault();
      }
    },
    [editor, effectiveReadOnly],
  );

  const handleFrameMouseDownCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (
        !editor ||
        effectiveReadOnly ||
        !(event.target instanceof HTMLElement)
      ) {
        return;
      }

      if (isContextMenuPointerTrigger(event.button, event.ctrlKey)) {
        if (storedTextSelectionRef.current && event.target.closest(".ProseMirror")) {
          event.preventDefault();
        }
        return;
      }

      if (event.button !== 0) {
        return;
      }

      if (
        event.target.closest(
          "button, a, input, select, textarea, [data-rich-editor-openable='true'], [contenteditable='false'], .rich-editor__rewrite-widget",
        )
      ) {
        return;
      }

      const proseMirrorTarget = event.target.closest(".ProseMirror");

      if (!proseMirrorTarget) {
        window.requestAnimationFrame(() => {
          editor.commands.focus("end");
        });
      }
    },
    [editor, effectiveReadOnly],
  );

  const toolbarGroups = useMemo(() => {
    if (!editor) {
      return [] as ToolbarItem[][];
    }

    const editorDisabled = () => readOnly || !editor.isEditable;

    return [
      [
        {
          key: "paragraph",
          label: "正文",
          icon: Pilcrow,
          isActive: () => editor.isActive("paragraph"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().setParagraph().run(),
        },
        {
          key: "h1",
          label: "H1",
          icon: Heading1,
          isActive: () => editor.isActive("heading", { level: 1 }),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        },
        {
          key: "h2",
          label: "H2",
          icon: Heading2,
          isActive: () => editor.isActive("heading", { level: 2 }),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        },
        {
          key: "h3",
          label: "H3",
          icon: Heading3,
          isActive: () => editor.isActive("heading", { level: 3 }),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
        },
      ],
      [
        {
          key: "bold",
          label: "加粗",
          icon: Bold,
          isActive: () => editor.isActive("bold"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleBold().run(),
        },
        {
          key: "italic",
          label: "斜体",
          icon: Italic,
          isActive: () => editor.isActive("italic"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleItalic().run(),
        },
        {
          key: "strike",
          label: "中划线",
          icon: Strikethrough,
          isActive: () => editor.isActive("strike"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleStrike().run(),
        },
        {
          key: "highlight",
          label: "着重色",
          icon: Highlighter,
          isActive: () => editor.isActive("highlight"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleHighlight().run(),
        },
      ],
      [
        {
          key: "ordered-list",
          label: "数字序号",
          icon: ListOrdered,
          isActive: () => editor.isActive("orderedList"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleOrderedList().run(),
        },
        {
          key: "bullet-list",
          label: "符号序号",
          icon: List,
          isActive: () => editor.isActive("bulletList"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          key: "task-list",
          label: "Todo list",
          icon: ListTodo,
          isActive: () => editor.isActive("taskList"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleTaskList().run(),
        },
        {
          key: "code-block",
          label: "代码段",
          icon: Code2,
          isActive: () => editor.isActive("codeBlock"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleCodeBlock().run(),
        },
        {
          key: "blockquote",
          label: "引用",
          icon: Quote,
          isActive: () => editor.isActive("blockquote"),
          isDisabled: editorDisabled,
          run: () => editor.chain().focus().toggleBlockquote().run(),
        },
      ],
      [
        {
          key: "image",
          label: "图片",
          icon: ImagePlus,
          isActive: () => false,
          isDisabled: () => editorDisabled() || !assetHandlers?.insertImage || assetBusy !== null,
          run: handleInsertImage,
          busy: assetBusy === "image",
        },
        ...(enableTables
          ? [
              {
                key: "table",
                label: "表格",
                icon: Table2,
                isActive: () => editor.isActive("table"),
                isDisabled: editorDisabled,
                run: insertTable,
              } satisfies ToolbarItem,
            ]
          : []),
        {
          key: "file",
          label: "文件",
          icon: Paperclip,
          isActive: () => false,
          isDisabled: () => editorDisabled() || !assetHandlers?.insertFile || assetBusy !== null,
          run: handleInsertFile,
          busy: assetBusy === "file",
        },
      ],
    ];
  }, [
    assetBusy,
    assetHandlers?.insertFile,
    assetHandlers?.insertImage,
    editor,
    enableTables,
    handleInsertFile,
    handleInsertImage,
    insertTable,
    readOnly,
    uiTick,
  ]);

  const aiMenuPrimaryActions = useMemo<RichEditorAiMenuIconAction[]>(() => {
    if (!editor) {
      return [];
    }

    const runWithSelection = (command: () => boolean) => {
      restoreStoredTextSelection(editor);
      command();
    };

    return [
      {
        key: "ordered-list",
        label: "有序列表",
        icon: ListOrdered,
        active: editor.isActive("orderedList"),
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleOrderedList().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleOrderedList().run()),
      },
      {
        key: "highlight",
        label: "着重色",
        icon: Highlighter,
        active: editor.isActive("highlight"),
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleHighlight().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleHighlight().run()),
      },
      {
        key: "bold",
        label: "加粗",
        icon: Bold,
        active: editor.isActive("bold"),
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleBold().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleBold().run()),
      },
      {
        key: "italic",
        label: "斜体",
        icon: Italic,
        active: editor.isActive("italic"),
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleItalic().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleItalic().run()),
      },
      {
        key: "strike",
        label: "中划线",
        icon: Strikethrough,
        active: editor.isActive("strike"),
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleStrike().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleStrike().run()),
      },
      {
        key: "code-block",
        label: "代码段",
        icon: Code2,
        active: editor.isActive("codeBlock"),
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleCodeBlock().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleCodeBlock().run()),
      },
    ];
  }, [editor, effectiveReadOnly, restoreStoredTextSelection, uiTick]);

  const aiMenuMoreActions = useMemo<RichEditorAiMenuTextAction[]>(() => {
    if (!editor) {
      return [];
    }

    const runWithSelection = (command: () => boolean) => {
      restoreStoredTextSelection(editor);
      command();
    };

    return [
      {
        key: "paragraph",
        label: "正文",
        disabled: effectiveReadOnly || !editor.can().chain().focus().setParagraph().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().setParagraph().run()),
      },
      {
        key: "h1",
        label: "H1",
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleHeading({ level: 1 }).run(),
        onSelect: () =>
          runWithSelection(() => editor.chain().focus().toggleHeading({ level: 1 }).run()),
      },
      {
        key: "h2",
        label: "H2",
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleHeading({ level: 2 }).run(),
        onSelect: () =>
          runWithSelection(() => editor.chain().focus().toggleHeading({ level: 2 }).run()),
      },
      {
        key: "h3",
        label: "H3",
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleHeading({ level: 3 }).run(),
        onSelect: () =>
          runWithSelection(() => editor.chain().focus().toggleHeading({ level: 3 }).run()),
      },
      {
        key: "bullet-list",
        label: "无序列表",
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleBulletList().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleBulletList().run()),
      },
      {
        key: "task-list",
        label: "Todo List",
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleTaskList().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleTaskList().run()),
      },
      {
        key: "blockquote",
        label: "引用",
        disabled: effectiveReadOnly || !editor.can().chain().focus().toggleBlockquote().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().toggleBlockquote().run()),
      },
      {
        key: "copy",
        label: "复制",
        disabled: false,
        onSelect: () => {
          restoreStoredTextSelection(editor);
          void runEditorClipboardCommand(editor, "copy");
        },
      },
      {
        key: "cut",
        label: "剪切",
        disabled: effectiveReadOnly || !editor.isEditable,
        onSelect: () => {
          restoreStoredTextSelection(editor);
          void runEditorClipboardCommand(editor, "cut");
        },
      },
      {
        key: "select-all",
        label: "全选",
        disabled: effectiveReadOnly || !editor.can().chain().focus().selectAll().run(),
        onSelect: () => runWithSelection(() => editor.chain().focus().selectAll().run()),
      },
    ];
  }, [editor, effectiveReadOnly, restoreStoredTextSelection, uiTick]);

  const aiMenuSkillActions = useMemo(
    () =>
      enabledRewriteActions.map((action) => ({
        id: action.id,
        label: action.label,
        disabled: Boolean(rewriteUnavailableReason),
        onSelect: () => runEditorRewriteAction(action.id, action.label),
      })),
    [enabledRewriteActions, rewriteUnavailableReason, runEditorRewriteAction],
  );

  if (!editor) {
    return <div className="rich-editor rich-editor--loading">加载编辑器中...</div>;
  }

  return (
    <div
      className={[
        "rich-editor",
        `rich-editor--${variant}`,
        effectiveReadOnly ? "is-readonly" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {variant === "toolbar" || variant === "page" ? (
        <div className="rich-editor__toolbar" aria-label="文本格式工具栏">
          <div className="rich-editor__toolbar-main">
            {toolbarGroups.map((group, index) => (
              <div key={index} className="rich-editor__toolbar-group" role="group">
                {group.map((item) => (
                  item.key === "table" ? (
                    <TableInsertButton
                      key={item.key}
                      active={item.isActive()}
                      disabled={item.isDisabled?.()}
                      onInsert={insertTable}
                    />
                  ) : (
                    <ToolbarButton
                      key={item.key}
                      type="button"
                      active={item.isActive()}
                      aria-label={item.label}
                      title={item.label}
                      disabled={item.isDisabled?.()}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        void Promise.resolve(item.run()).catch(() => {
                          // The caller owns error presentation.
                        });
                      }}
                    >
                      {item.busy ? (
                        <LoaderCircle className="rich-editor__tool-spinner" size={15} />
                      ) : (
                        <item.icon size={15} />
                      )}
                    </ToolbarButton>
                  )
                ))}
              </div>
            ))}
          </div>
          {renderToolbarExtras ? (
            <div className="rich-editor__toolbar-extras">
              {renderToolbarExtras({
                persistState,
                save: handleManualSave,
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Table toolbar - only shows when table is active, positioned above editor */}
      {tableToolbarGroups.length > 0 ? (
        <div
          className={[
            "rich-editor__table-toolbar",
            variant === "bare" ? "rich-editor__table-toolbar--bare" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label="表格工具栏"
        >
          {tableToolbarGroups.map((group, index) => (
            <div key={index} className="rich-editor__table-toolbar-group" role="group">
              {group.map((item) => (
                <ToolbarButton
                  key={item.key}
                  type="button"
                  active={item.isActive()}
                  aria-label={item.label}
                  title={item.label}
                  disabled={item.isDisabled?.()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    void Promise.resolve(item.run()).catch(() => {
                      // The caller owns error presentation.
                    });
                  }}
                >
                  <item.icon size={15} />
                </ToolbarButton>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* Remove table insert button from bare variant - now in context menu */}
      {false && variant === "bare" && enableTables && !effectiveReadOnly && isFocused ? (
        <div className="rich-editor__bare-actions">
          <TableInsertButton compact onInsert={insertTable} />
        </div>
      ) : null}

      <div
        ref={frameRef}
        className="rich-editor__frame"
        onPointerDownCapture={handleFramePointerDownCapture}
        onMouseDownCapture={handleFrameMouseDownCapture}
        onClick={handleFrameClick}
        onDoubleClick={handleEditorDoubleClick}
        onContextMenu={handleEditorContextMenu}
      >
        <EditorContent editor={editor} onBlur={(event) => void handleBlur(event.relatedTarget)} />

        {referencePicker && internalReferences?.context && !effectiveReadOnly ? (
          <InternalReferencePicker
            open
            loading={referenceLoading}
            results={referenceResults}
            activeIndex={referenceActiveIndex}
            className="absolute z-20 w-[22rem]"
            style={{
              left: `${referencePicker.position.left}px`,
              top: `${referencePicker.position.top}px`,
            }}
            onHoverIndex={setReferenceActiveIndex}
            onSelect={(reference) => {
              void handleSelectInternalReference(editor.view, reference);
            }}
          />
        ) : null}
        {mentionPicker && contactMentions && !effectiveReadOnly ? (
          <ContactMentionPicker
            open
            loading={mentionLoading}
            results={mentionResults}
            activeIndex={mentionActiveIndex}
            query={mentionPicker.query}
            canCreate={mentionCreatable}
            className="absolute z-20"
            style={{
              left: `${mentionPicker.position.left}px`,
              top: `${mentionPicker.position.top}px`,
            }}
            onHoverIndex={setMentionActiveIndex}
            onSelect={(contact) => {
              void handleSelectContactMention(editor.view, contact);
            }}
            onCreate={(name) => {
              void handleCreateContactMention(editor.view, name);
            }}
          />
        ) : null}
      </div>
      {contextMenu ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel={contextMenu.ariaLabel}
          actions={contextMenu.actions}
          autoFocus={contextMenu.autoFocus}
          onClose={closeContextMenu}
        />
      ) : null}
      {aiMenu ? (
        <RichEditorAiMenu
          x={aiMenu.x}
          y={aiMenu.y}
          primaryActions={aiMenuPrimaryActions}
          moreActions={aiMenuMoreActions}
          skills={aiMenuSkillActions}
          disabledReason={rewriteUnavailableReason}
          onClose={closeAiMenu}
          onOpenSettings={onOpenAiSettings}
          onSubmitPrompt={runEditorRewritePrompt}
        />
      ) : null}
      {annotationDialog ? (
        <ImageAnnotationDialog
          open
          readOnly={readOnly}
          title={annotationDialog.title}
          imageSrc={annotationDialog.imageSrc}
          initialAnnotationState={annotationDialog.annotationState}
          imageSize={annotationDialog.imageSize}
          onClose={() => setAnnotationDialog(null)}
          onSave={handleAnnotationSave}
        />
      ) : null}
    </div>
  );
}

function TableInsertButton({
  active = false,
  compact = false,
  disabled = false,
  onInsert,
}: {
  active?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onInsert: (rows: number, cols: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredDimensions, setHoveredDimensions] = useState(DEFAULT_TABLE_DIMENSIONS);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;

      if (!target || rootRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const openPicker = useCallback(() => {
    setHoveredDimensions(DEFAULT_TABLE_DIMENSIONS);
    setOpen(true);
  }, []);

  return (
    <div
      ref={rootRef}
      className={[
        "rich-editor__insert-table",
        compact ? "rich-editor__insert-table--compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {compact ? (
        <button
          type="button"
          className="rich-editor__bare-action-button"
          disabled={disabled}
          aria-label="插入表格"
          title="插入表格"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }

            openPicker();
          }}
        >
          <Grid2X2Plus size={15} />
          <span>表格</span>
        </button>
      ) : (
        <ToolbarButton
          type="button"
          active={active || open}
          aria-label="表格"
          title="表格"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }

            openPicker();
          }}
        >
          <Table2 size={15} />
        </ToolbarButton>
      )}

      {open ? (
        <PopoverPanel className="rich-editor__insert-table-panel">
          <div className="rich-editor__insert-table-grid" role="menu" aria-label="表格尺寸选择">
            {Array.from({ length: TABLE_INSERT_GRID_SIZE }, (_, rowIndex) =>
              Array.from({ length: TABLE_INSERT_GRID_SIZE }, (_, colIndex) => {
                const rows = rowIndex + 1;
                const cols = colIndex + 1;
                const selected =
                  rowIndex < hoveredDimensions.rows && colIndex < hoveredDimensions.cols;

                return (
                  <button
                    key={`${rows}:${cols}`}
                    type="button"
                    className={[
                      "rich-editor__insert-table-cell",
                      selected ? "is-selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-label={`插入 ${rows} 行 ${cols} 列表格`}
                    title={`${rows} x ${cols}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHoveredDimensions({ rows, cols })}
                    onFocus={() => setHoveredDimensions({ rows, cols })}
                    onClick={() => {
                      onInsert(rows, cols);
                      setOpen(false);
                    }}
                  />
                );
              }),
            )}
          </div>
          <p className="rich-editor__insert-table-summary">
            {hoveredDimensions.rows} x {hoveredDimensions.cols}
          </p>
        </PopoverPanel>
      ) : null}
    </div>
  );
}

function focusEditorForAutoFocus(
  editor: Editor,
  autoFocus: boolean | RichEditorAutoFocusPoint,
) {
  if (typeof autoFocus === "object") {
    const point =
      autoFocus.mode === "content-relative"
        ? resolveRelativeAutoFocusPoint(editor, autoFocus)
        : {
            left: autoFocus.x,
            top: autoFocus.y,
          };
    const focusPosition = editor.view.posAtCoords({
      left: point.left,
      top: point.top,
    });

    if (focusPosition) {
      editor.commands.focus(focusPosition.pos);
      return;
    }
  }

  editor.commands.focus("end");
}

function resolveRelativeAutoFocusPoint(editor: Editor, autoFocus: RichEditorAutoFocusPoint) {
  const rect = editor.view.dom.getBoundingClientRect();

  return {
    left: rect.left + autoFocus.x,
    top: rect.top + autoFocus.y,
  };
}

function resolveEditorInternalReferenceTrigger(
  editor: Editor,
  frameElement: HTMLDivElement | null,
) {
  if (!frameElement || !editor.isEditable) {
    return null;
  }

  const { selection } = editor.state;

  if (!(selection instanceof TextSelection) || !selection.empty || editor.isActive("codeBlock")) {
    return null;
  }

  const trigger = findInternalReferenceTextTrigger(
    editor.state.doc.textBetween(selection.$from.start(), selection.from, "\n", "\0"),
    selection.$from.parentOffset,
  );

  if (!trigger) {
    return null;
  }

  const absoluteStart = selection.from - trigger.query.length - 2;
  const frameRect = frameElement.getBoundingClientRect();
  const caretRect = editor.view.coordsAtPos(selection.from);

  return {
    start: absoluteStart,
    end: selection.from,
    query: trigger.query,
    position: {
      left: Math.max(8, caretRect.left - frameRect.left),
      top: Math.max(8, caretRect.bottom - frameRect.top + 8),
    },
  };
}

function resolveEditorContactMentionTrigger(
  editor: Editor,
  frameElement: HTMLDivElement | null,
) {
  if (!frameElement || !editor.isEditable) {
    return null;
  }

  const { selection } = editor.state;

  if (!(selection instanceof TextSelection) || !selection.empty || editor.isActive("codeBlock")) {
    return null;
  }

  const trigger = findContactMentionTextTrigger(
    editor.state.doc.textBetween(selection.$from.start(), selection.from, "\n", "\0"),
    selection.$from.parentOffset,
  );

  if (!trigger) {
    return null;
  }

  // The `@` trigger token is a single character.
  const absoluteStart = selection.from - trigger.query.length - 1;
  const frameRect = frameElement.getBoundingClientRect();
  const caretRect = editor.view.coordsAtPos(selection.from);

  return {
    start: absoluteStart,
    end: selection.from,
    query: trigger.query,
    position: {
      left: Math.max(8, caretRect.left - frameRect.left),
      top: Math.max(8, caretRect.bottom - frameRect.top + 8),
    },
  };
}

function applyTaskListMarkdownShortcut(editor: Editor) {
  const { $from } = editor.state.selection;

  if ($from.parent.type.name !== "paragraph" || $from.depth < 2) {
    return false;
  }

  const listItemNode = $from.node($from.depth - 1);
  const parentListNode = $from.node($from.depth - 2);

  if (listItemNode.type.name !== "listItem" || parentListNode.type.name !== "bulletList") {
    return false;
  }

  if (parentListNode.childCount !== 1) {
    return false;
  }

  const match = $from.parent.textContent.match(/^\[( |x|X)\]\s/);

  if (!match) {
    return false;
  }

  const checked = match[1].toLowerCase() === "x";
  const prefixLength = match[0].length;
  const paragraphStart = $from.start();

  editor
    .chain()
    .command(({ tr }) => {
      tr.delete(paragraphStart, paragraphStart + prefixLength);
      return true;
    })
    .toggleTaskList()
    .updateAttributes("taskItem", { checked })
    .run();

  return true;
}

function ensureInsertionCursor({ tr }: { tr: Editor["state"]["tr"] }) {
  if (!(tr.selection instanceof NodeSelection)) {
    return true;
  }

  const paragraph = tr.doc.type.schema.nodes.paragraph;

  if (!paragraph) {
    return true;
  }

  const insertionPos = tr.selection.to;

  tr.insert(insertionPos, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, insertionPos + 1));

  return true;
}

function insertObjectBlock(editor: Editor, block: JSONContent) {
  editor
    .chain()
    .focus()
    .command(ensureInsertionCursor)
    .insertContent([block, { type: "paragraph" }], {
      updateSelection: true,
    })
    .run();
}

function normalizeHtml(html?: string) {
    const nextHtml = repairRichTextAssetHtml(html)?.trim();
  return nextHtml && nextHtml.length > 0 ? nextHtml : EMPTY_RICH_EDITOR_HTML;
}

function sanitizePastedHtml(rawHtml: string) {
  if (!rawHtml || typeof DOMParser === "undefined") {
    return rawHtml;
  }

  const doc = new DOMParser().parseFromString(rawHtml, "text/html");

  doc.querySelectorAll("*").forEach((element) => {
    const className = element.getAttribute("class");

    if (className?.includes("Mso")) {
      element.removeAttribute("class");
    }

    const style = element.getAttribute("style");

    if (!style) {
      return;
    }

    const filtered = style
      .split(";")
      .map((rule) => rule.trim())
      .filter((rule) => rule.length > 0)
      .filter((rule) => !rule.startsWith("mso-"))
      .filter((rule) => !rule.includes("tab-stops"))
      .filter((rule) => !rule.includes("layout-grid"))
      .join("; ");

    if (filtered.length > 0) {
      element.setAttribute("style", filtered);
      return;
    }

    element.removeAttribute("style");
  });

  return doc.body.innerHTML;
}

function serializeEditor(editor: Editor): RichEditorValue {
  return {
    html: normalizeHtml(editor.getHTML()),
    text: editor.getText({
      blockSeparator: "\n\n",
    }),
    markdown: serializeEditorMarkdown(editor),
  };
}

function buildTableToolbarGroups(editor: Editor, readOnly: boolean) {
  const editorDisabled = () => readOnly || !editor.isEditable;

  return [
    [
      {
        key: "add-row-before",
        label: "上方插入行",
        icon: ArrowUpToLine,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().addRowBefore(),
        run: () => editor.chain().focus().addRowBefore().run(),
      },
      {
        key: "add-row-after",
        label: "下方插入行",
        icon: ArrowDownToLine,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().addRowAfter(),
        run: () => editor.chain().focus().addRowAfter().run(),
      },
      {
        key: "add-column-before",
        label: "左侧插入列",
        icon: ArrowLeftToLine,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().addColumnBefore(),
        run: () => editor.chain().focus().addColumnBefore().run(),
      },
      {
        key: "add-column-after",
        label: "右侧插入列",
        icon: ArrowRightToLine,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().addColumnAfter(),
        run: () => editor.chain().focus().addColumnAfter().run(),
      },
    ],
    [
      {
        key: "merge-cells",
        label: "合并单元格",
        icon: Combine,
        isActive: () => editor.state.selection instanceof CellSelection,
        isDisabled: () => editorDisabled() || !editor.can().mergeCells(),
        run: () => editor.chain().focus().mergeCells().run(),
      },
      {
        key: "split-cell",
        label: "拆分单元格",
        icon: Split,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().splitCell(),
        run: () => editor.chain().focus().splitCell().run(),
      },
      {
        key: "toggle-header-row",
        label: "切换首行表头",
        icon: PanelTop,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().toggleHeaderRow(),
        run: () => editor.chain().focus().toggleHeaderRow().run(),
      },
      {
        key: "toggle-header-column",
        label: "切换首列表头",
        icon: PanelLeft,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().toggleHeaderColumn(),
        run: () => editor.chain().focus().toggleHeaderColumn().run(),
      },
    ],
    [
      {
        key: "delete-row",
        label: "删除当前行",
        icon: Rows2,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().deleteRow(),
        run: () => editor.chain().focus().deleteRow().run(),
      },
      {
        key: "delete-column",
        label: "删除当前列",
        icon: Columns2,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().deleteColumn(),
        run: () => editor.chain().focus().deleteColumn().run(),
      },
      {
        key: "delete-table",
        label: "删除表格",
        icon: Trash2,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().deleteTable(),
        run: () => editor.chain().focus().deleteTable().run(),
      },
    ],
  ] satisfies ToolbarItem[][];
}

function buildTableContextMenuActions(groups: ToolbarItem[][]) {
  return groups.flatMap((group, groupIndex) => {
    const mapped = group.map(
      (item) =>
        ({
          key: item.key,
          label: item.label,
          icon: item.icon,
          disabled: item.isDisabled?.(),
          tone: item.key === "delete-table" ? "danger" : "default",
          onSelect: () => {
            void Promise.resolve(item.run()).catch(() => {
              // The caller owns error presentation.
            });
          },
        }) satisfies ContextMenuAction,
    );

    if (groupIndex === groups.length - 1) {
      return mapped;
    }

    return [...mapped, { type: "separator", key: `table-separator-${groupIndex}` } satisfies ContextMenuAction];
  });
}

function buildRichEditorSelectionPayload(editor: Editor): RichEditorSelectionPayload | null {
  const selection = buildEditorRewriteSelection(editor);

  if (!selection || !selection.expandedMarkdown.trim()) {
    return null;
  }

  return {
    text: selection.selectedText.trim(),
    markdown: selection.expandedMarkdown.trim(),
    html: renderMarkdownToHtml(selection.expandedMarkdown),
  };
}

function buildSelectionContextMenuActions({
  editor,
  readOnly,
  selectionActions,
  selectionPayload,
}: {
  editor: Editor;
  readOnly: boolean;
  selectionActions: RichEditorSelectionAction[];
  selectionPayload: RichEditorSelectionPayload;
}) {
  const customActions: ContextMenuAction[] = selectionActions.map((action) => ({
    key: action.key,
    label: action.label,
    icon: action.icon,
    disabled: action.disabled,
    onSelect: () => {
      void Promise.resolve(action.onSelect(selectionPayload));
    },
  }));

  return [
    ...customActions,
    { type: "separator", key: "selection-actions-separator" } satisfies ContextMenuAction,
    ...buildTextContextMenuActions(editor, readOnly),
  ];
}

function buildTextContextMenuActions(
  editor: Editor,
  readOnly: boolean,
  insertTable?: (rows?: number, cols?: number) => void,
) {
  const canRun = (callback: (chain: any) => { run: () => boolean }) =>
    !readOnly && editor.isEditable && callback(editor.can().chain().focus()).run();
  const runCommand = (callback: (chain: any) => { run: () => boolean }) => () => {
    callback(editor.chain().focus()).run();
  };
  const formatActions: ContextMenuAction[] = [
    {
      key: "text-bold",
      label: "加粗",
      icon: Bold,
      shortcut: "Mod+B",
      disabled: !canRun((chain) => chain.toggleBold()),
      onSelect: runCommand((chain) => chain.toggleBold()),
    },
    {
      key: "text-italic",
      label: "斜体",
      icon: Italic,
      shortcut: "Mod+I",
      disabled: !canRun((chain) => chain.toggleItalic()),
      onSelect: runCommand((chain) => chain.toggleItalic()),
    },
    {
      key: "text-highlight",
      label: "着重色",
      icon: Highlighter,
      disabled: !canRun((chain) => chain.toggleHighlight()),
      onSelect: runCommand((chain) => chain.toggleHighlight()),
    },
  ];

  const blockActions: ContextMenuAction[] = [
    {
      key: "text-paragraph",
      label: "正文",
      icon: Pilcrow,
      disabled: !canRun((chain) => chain.setParagraph()),
      onSelect: runCommand((chain) => chain.setParagraph()),
    },
    {
      key: "text-h1",
      label: "H1",
      icon: Heading1,
      disabled: !canRun((chain) => chain.toggleHeading({ level: 1 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 1 })),
    },
    {
      key: "text-h2",
      label: "H2",
      icon: Heading2,
      disabled: !canRun((chain) => chain.toggleHeading({ level: 2 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 2 })),
    },
    {
      key: "text-h3",
      label: "H3",
      icon: Heading3,
      disabled: !canRun((chain) => chain.toggleHeading({ level: 3 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 3 })),
    },
    {
      key: "text-bullet-list",
      label: "无序列表",
      icon: List,
      disabled: !canRun((chain) => chain.toggleBulletList()),
      onSelect: runCommand((chain) => chain.toggleBulletList()),
    },
    {
      key: "text-ordered-list",
      label: "有序列表",
      icon: ListOrdered,
      disabled: !canRun((chain) => chain.toggleOrderedList()),
      onSelect: runCommand((chain) => chain.toggleOrderedList()),
    },
    {
      key: "text-task-list",
      label: "Todo List",
      icon: ListTodo,
      disabled: !canRun((chain) => chain.toggleTaskList()),
      onSelect: runCommand((chain) => chain.toggleTaskList()),
    },
    {
      key: "text-blockquote",
      label: "引用",
      icon: Quote,
      disabled: !canRun((chain) => chain.toggleBlockquote()),
      onSelect: runCommand((chain) => chain.toggleBlockquote()),
    },
    {
      key: "text-code-block",
      label: "代码段",
      icon: Code2,
      disabled: !canRun((chain) => chain.toggleCodeBlock()),
      onSelect: runCommand((chain) => chain.toggleCodeBlock()),
    },
  ];

  const clipboardActions: ContextMenuAction[] = [
    {
      key: "text-copy",
      label: "复制",
      icon: Copy,
      shortcut: "Mod+C",
      disabled: false,
      onSelect: () => {
        void runEditorClipboardCommand(editor, "copy");
      },
    },
    {
      key: "text-cut",
      label: "剪切",
      icon: Scissors,
      shortcut: "Mod+X",
      disabled: readOnly || !editor.isEditable,
      onSelect: () => {
        void runEditorClipboardCommand(editor, "cut");
      },
    },
    {
      key: "text-select-all",
      label: "全选",
      icon: TextSelect,
      shortcut: "Mod+A",
      disabled: !editor.can().chain().focus().selectAll().run(),
      onSelect: runCommand((chain) => chain.selectAll()),
    },
  ];

  const groupedActions: ContextMenuAction[] = [
    {
      type: "submenu",
      key: "text-group-format",
      label: "格式",
      icon: Bold,
      actions: formatActions,
      disabled: formatActions.every((action) => action.type !== "separator" && action.disabled),
    },
    {
      type: "submenu",
      key: "text-group-block",
      label: "块",
      icon: Pilcrow,
      actions: blockActions,
      disabled: blockActions.every((action) => action.type !== "separator" && action.disabled),
    },
  ];

  // Add insert table option if insertTable is provided
  if (insertTable && !readOnly) {
    groupedActions.push({
      key: "insert-table",
      label: "插入表格",
      icon: Table2,
      disabled: false,
      onSelect: () => insertTable(),
    });
  }

  groupedActions.push({
    type: "submenu",
    key: "text-group-clipboard",
    label: "剪贴板",
    icon: Copy,
    actions: clipboardActions,
    disabled: clipboardActions.every((action) => action.type !== "separator" && action.disabled),
  });

  return groupedActions;
}

function createEditorRewriteWidgetPlugin(options: {
  getWidgetState: () => EditorRewriteWidgetState | null;
  getCallbacks: () => {
    onAccept: () => void;
    onClose: () => void;
    onOpenAiSettings?: () => void;
  };
}) {
  let widgetRoot: Root | null = null;
  let widgetDom: HTMLDivElement | null = null;

  const ensureWidgetDom = () => {
    if (!widgetDom) {
      widgetDom = document.createElement("div");
      widgetDom.className = "rich-editor__rewrite-widget-host";
      widgetRoot = createRoot(widgetDom);
    }

    return widgetDom;
  };

  const renderWidget = () => {
    const widgetState = options.getWidgetState();
    if (!widgetRoot) {
      return;
    }

    if (!widgetState) {
      widgetRoot.render(null);
      return;
    }

    widgetRoot.render(
      <RichEditorRewriteWidget
        actionLabel={widgetState.actionLabel}
        status={widgetState.status}
        previewHtml={widgetState.previewHtml}
        errorMessage={widgetState.errorMessage}
        onAccept={options.getCallbacks().onAccept}
        onClose={options.getCallbacks().onClose}
        onOpenAiSettings={options.getCallbacks().onOpenAiSettings}
      />,
    );
  };

  return new Plugin({
    key: RICH_EDITOR_REWRITE_WIDGET_PLUGIN_KEY,
    state: {
      init: () => 0,
      apply(tr, value) {
        return tr.getMeta(RICH_EDITOR_REWRITE_WIDGET_PLUGIN_KEY) ?? value;
      },
    },
    props: {
      decorations(state) {
        const widgetState = options.getWidgetState();

        if (!widgetState) {
          return null;
        }

        const decorations = widgetState.blockRanges
          .filter((range) => !range.isPlaceholder)
          .map((range) =>
            Decoration.node(range.from - 1, range.to, {
              class: "rich-editor__rewrite-origin-block",
            }),
          );

        decorations.push(
          Decoration.widget(
            widgetState.anchorPos,
            () => {
              const dom = ensureWidgetDom();
              renderWidget();
              return dom;
            },
            {
              side: 1,
              ignoreSelection: true,
              key: "rich-editor-rewrite-widget",
              stopEvent: (event) =>
                event.target instanceof Node
                  ? ensureWidgetDom().contains(event.target)
                  : false,
            },
          ),
        );

        return DecorationSet.create(state.doc, decorations);
      },
    },
    view() {
      renderWidget();
      return {
        update() {
          renderWidget();
        },
        destroy() {
          const rootToUnmount = widgetRoot;
          widgetRoot = null;
          widgetDom = null;
          queueMicrotask(() => {
            rootToUnmount?.unmount();
          });
        },
      };
    },
  });
}

function buildImageContextMenuActions({
  editor,
  imageTarget,
  onBrowseImage,
  readOnly,
}: {
  editor: Editor;
  imageTarget: ImageContextMenuTarget;
  onBrowseImage: (target?: Element | null) => void;
  readOnly: boolean;
}) {
  const canBrowseImage = Boolean(imageTarget.attrs.path || imageTarget.attrs.src);
  const canOpenOriginal = Boolean(imageTarget.attrs.path || imageTarget.attrs.src);
  const canRevealPath = Boolean(imageTarget.attrs.path);
  const canEditImage = !readOnly && editor.isEditable;

  return [
    {
      key: "image-browse",
      label: "浏览图片",
      icon: Maximize2,
      disabled: !canBrowseImage,
      onSelect: () => {
        onBrowseImage();
      },
    },
    {
      key: "image-open-original",
      label: "在系统中打开原图",
      icon: ExternalLink,
      disabled: !canOpenOriginal,
      onSelect: () => {
        void openImageOriginal(imageTarget.attrs);
      },
    },
    {
      key: "image-reveal-path",
      label: "打开图片所在位置",
      icon: FolderOpen,
      disabled: !canRevealPath,
      onSelect: () => {
        if (imageTarget.attrs.path) {
          void desktopApi.revealPath(imageTarget.attrs.path).catch(() => {
            // The caller owns error presentation.
          });
        }
      },
    },
    { type: "separator", key: "image-separator-size" },
    {
      key: "image-width-small",
      label: "小图（240px）",
      icon: ImageUp,
      disabled: !canEditImage,
      onSelect: () => updateImageNodeWidth(editor, imageTarget.nodePos, 240),
    },
    {
      key: "image-width-medium",
      label: "中图（360px）",
      icon: ImageUp,
      disabled: !canEditImage,
      onSelect: () => updateImageNodeWidth(editor, imageTarget.nodePos, 360),
    },
    {
      key: "image-width-large",
      label: "大图（520px）",
      icon: ImageUp,
      disabled: !canEditImage,
      onSelect: () => updateImageNodeWidth(editor, imageTarget.nodePos, 520),
    },
    {
      key: "image-width-reset",
      label: "重置为自适应宽度",
      icon: Maximize2,
      disabled: !canEditImage,
      onSelect: () => updateImageNodeWidth(editor, imageTarget.nodePos, null),
    },
    { type: "separator", key: "image-separator-delete" },
    {
      key: "image-delete",
      label: "删除图片",
      icon: Trash2,
      disabled: !canEditImage,
      tone: "danger",
      onSelect: () => removeNodeAtPos(editor, imageTarget.nodePos),
    },
  ] satisfies ContextMenuAction[];
}

function hasExpandedTextSelection(editor: Editor) {
  return editor.state.selection instanceof TextSelection && !editor.state.selection.empty;
}

function isContextMenuPointerTrigger(button: number, ctrlKey: boolean) {
  return button === 2 || (button === 0 && ctrlKey);
}

function readDomTextSelection(editor: Editor): StoredTextSelection | null {
  const domSelection = window.getSelection();

  if (
    !domSelection ||
    domSelection.rangeCount === 0 ||
    domSelection.isCollapsed ||
    domSelection.toString().trim().length === 0
  ) {
    return null;
  }

  const range = domSelection.getRangeAt(0);
  const { startContainer, endContainer, startOffset, endOffset } = range;

  if (
    !editor.view.dom.contains(startContainer) ||
    !editor.view.dom.contains(endContainer)
  ) {
    return null;
  }

  try {
    const start = editor.view.posAtDOM(startContainer, startOffset);
    const end = editor.view.posAtDOM(endContainer, endOffset);
    const from = Math.min(start, end);
    const to = Math.max(start, end);

    return from === to ? null : { from, to };
  } catch {
    return null;
  }
}

function syncDomTextSelectionToEditor(editor: Editor) {
  const domSelection = readDomTextSelection(editor);
  if (!domSelection) {
    return false;
  }

  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, domSelection.from, domSelection.to),
    ),
  );
  return true;
}

function syncStoredTextSelectionToEditor(
  editor: Editor,
  storedSelection: StoredTextSelection | null,
  options: {
    coords?: { left: number; top: number };
    target?: Element | null;
  },
) {
  if (!storedSelection) {
    return false;
  }

  const anchorPos = resolveContextMenuAnchorPos(editor, options.target ?? null, options.coords);

  if (anchorPos === null) {
    return false;
  }

  const sameTextBlock = isPosWithinSameTextBlock(editor, anchorPos, storedSelection);

  if (anchorPos < storedSelection.from || anchorPos > storedSelection.to) {
    if (!sameTextBlock) {
      return false;
    }
  }

  try {
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, storedSelection.from, storedSelection.to),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

function resolveContextMenuAnchorPos(
  editor: Editor,
  target: Element | null,
  coords?: { left: number; top: number },
) {
  const clampPos = (pos: number) =>
    Math.max(1, Math.min(pos, editor.state.doc.content.size));

  const hit = coords ? editor.view.posAtCoords(coords) : null;
  if (hit) {
    return clampPos(hit.pos);
  }

  const candidateEntries: Array<{ node: Node; offset: number }> = [];
  const pushCandidate = (node: Node | null, offset = 0) => {
    if (!node || !editor.view.dom.contains(node)) {
      return;
    }

    if (candidateEntries.some((entry) => entry.node === node && entry.offset === offset)) {
      return;
    }

    candidateEntries.push({ node, offset });
  };

  pushCandidate(target);
  pushCandidate(target?.firstChild ?? null);
  pushCandidate(findFirstTextDescendant(target));

  for (const candidate of candidateEntries) {
    try {
      return clampPos(editor.view.posAtDOM(candidate.node, candidate.offset));
    } catch {
      continue;
    }
  }

  return null;
}

function findFirstTextDescendant(node: Node | null) {
  if (!node) {
    return null;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return node as Text;
  }

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function isPosWithinSameTextBlock(
  editor: Editor,
  pos: number,
  storedSelection: StoredTextSelection,
) {
  const range = resolveTextBlockRange(editor, pos);

  if (!range) {
    return false;
  }

  return storedSelection.from >= range.from && storedSelection.to <= range.to;
}

function resolveTextBlockRange(editor: Editor, pos: number) {
  const clampedPos = Math.max(1, Math.min(pos, editor.state.doc.content.size));
  const resolvedPos = editor.state.doc.resolve(clampedPos);

  for (let depth = resolvedPos.depth; depth > 0; depth -= 1) {
    if (resolvedPos.node(depth).isTextblock) {
      return {
        from: resolvedPos.start(depth),
        to: resolvedPos.end(depth),
      };
    }
  }

  return null;
}

function resolveImageContextMenuTarget(
  editor: Editor,
  target: Element | null,
): ImageContextMenuTarget | null {
  const selection = editor.state.selection;

  if (selection instanceof NodeSelection && selection.node.type.name === "image") {
    return {
      nodePos: selection.from,
      attrs: selection.node.attrs as ImageContextMenuTarget["attrs"],
    };
  }

  const imageElement = target?.closest(".rich-editor__image-node, img.rich-editor__image");

  if (!(imageElement instanceof HTMLElement)) {
    return null;
  }

  const nodePos = resolveImageNodePos(editor, imageElement);

  if (typeof nodePos !== "number") {
    return null;
  }

  const node = editor.state.doc.nodeAt(nodePos);

  if (!node || node.type.name !== "image") {
    return null;
  }

  return {
    nodePos,
    attrs: node.attrs as ImageContextMenuTarget["attrs"],
  };
}

function resolveImageNodePos(editor: Editor, element: HTMLElement) {
  const imageElement = element.matches("img.rich-editor__image")
    ? element
    : element.querySelector<HTMLElement>("img.rich-editor__image");

  if (imageElement) {
    try {
      const pos = editor.view.posAtDOM(imageElement, 0);

      for (const candidatePos of [pos, pos - 1, pos + 1]) {
        if (candidatePos < 0) {
          continue;
        }

        const candidateNode = editor.state.doc.nodeAt(candidatePos);

        if (candidateNode?.type.name === "image") {
          return candidatePos;
        }
      }
    } catch {
      // Fall back to a slower ancestor walk below.
    }
  }

  return findNodePos(editor.view, element, "image");
}

function resolveTableFocusPos(editor: Editor, target: Element | null) {
  if (editor.isActive("table")) {
    return editor.state.selection.from;
  }

  const tableHost = target?.closest("td, th, .tableWrapper, table, .rich-editor__table-node");

  if (!(tableHost instanceof HTMLElement)) {
    return null;
  }

  const cell = tableHost.matches("td, th")
    ? tableHost
    : tableHost.querySelector<HTMLElement>("td, th");

  if (!(cell instanceof HTMLElement)) {
    return null;
  }

  try {
    return editor.view.posAtDOM(cell, 0);
  } catch {
    return null;
  }
}

function shouldIgnoreRichEditorContextMenuTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target.closest(".ProseMirror")) {
    return false;
  }

  return shouldIgnoreContextMenuTarget(target);
}

function selectImageNode(editor: Editor, nodePos: number) {
  const { doc, tr } = editor.state;
  const node = doc.nodeAt(nodePos);

  if (!node || node.type.name !== "image") {
    return;
  }

  tr.setSelection(NodeSelection.create(doc, nodePos));
  editor.view.dispatch(tr);
}

function focusTableAtPos(editor: Editor, pos: number) {
  const resolvedPos = editor.state.doc.resolve(Math.min(pos + 1, editor.state.doc.content.size));
  const selection = TextSelection.near(resolvedPos);
  const tr = editor.state.tr.setSelection(selection);

  editor.view.dispatch(tr);
}

function updateImageNodeWidth(editor: Editor, nodePos: number, width: number | null) {
  updateImageNodeAttrs(editor, nodePos, { width });
}

function updateImageNodeAttrs(
  editor: Editor,
  nodePos: number,
  attrs: Partial<ImageContextMenuTarget["attrs"]>,
) {
  const node = editor.state.doc.nodeAt(nodePos);

  if (!node || node.type.name !== "image") {
    return;
  }

  const tr = editor.state.tr;

  tr.setSelection(NodeSelection.create(tr.doc, nodePos));
  tr.setNodeMarkup(nodePos, undefined, {
    ...node.attrs,
    ...attrs,
  });
  editor.view.dispatch(tr);
}

function removeNodeAtPos(editor: Editor, nodePos: number) {
  const node = editor.state.doc.nodeAt(nodePos);

  if (!node) {
    return;
  }

  const tr = editor.state.tr.delete(nodePos, nodePos + node.nodeSize);

  editor.view.dispatch(tr);
}

async function openImageOriginal(attrs: ImageContextMenuTarget["attrs"]) {
  if (attrs.path) {
    await desktopApi.openFile(attrs.path);
    return;
  }

  if (attrs.src) {
    window.open(attrs.src, "_blank", "noopener,noreferrer");
  }
}

async function runEditorClipboardCommand(editor: Editor, command: "copy" | "cut") {
  editor.commands.focus();

  try {
    const execCommand = document.execCommand?.(command);

    if (execCommand) {
      return;
    }
  } catch {
    // Fall through to best-effort clipboard APIs.
  }

  if (command === "copy") {
    const selectedText = serializeRichTextClipboard(
      editor.state.selection.content(),
      editor.view,
    );

    if (!selectedText) {
      return;
    }

    try {
      await navigator.clipboard?.writeText(selectedText);
    } catch {
      // Clipboard permissions vary by webview/browser; fail silently.
    }
  }
}

function serializeRichTextClipboard(content: Slice, view: EditorView) {
  if (typeof document === "undefined") {
    return content.content.textBetween(0, content.content.size, "\n");
  }

  const serializer = DOMSerializer.fromSchema(view.state.schema);
  const container = document.createElement("div");

  container.appendChild(serializer.serializeFragment(content.content, { document }));

  return richTextHtmlToPlainText(container.innerHTML, {
    preserveStructure: true,
  });
}

function findNodePos(editorView: EditorView, element: HTMLElement, nodeTypeName: string) {
  let pos: number;

  try {
    pos = editorView.posAtDOM(element, 0);
  } catch {
    return undefined;
  }

  const $pos = editorView.state.doc.resolve(pos);

  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    if ($pos.node(depth).type.name === nodeTypeName) {
      return depth === 0 ? 0 : $pos.before(depth);
    }
  }

  return undefined;
}

async function pickPath(options: {
  title: string;
  filters?: { name: string; extensions: string[] }[];
}) {
  return desktopApi.pickFile({
    title: options.title,
    filters: options.filters,
  });
}

async function buildPastedImageAttrs(
  file: File,
  assetHandlers?: RichEditorAssetHandlers,
) {
  if (assetHandlers?.insertPastedImage) {
    const asset = await assetHandlers.insertPastedImage(file);
    const src = await resolveStoredImageSrc(asset, file);

    if (src) {
      return {
        src,
        alt: asset.title,
        title: asset.title,
        path: asset.path,
        mimeType: asset.mimeType,
        documentId: asset.documentId,
      };
    }
  }

  const nativePath = (file as File & { path?: string }).path?.trim();

  if (nativePath && assetHandlers?.insertImage) {
    try {
      const asset = await assetHandlers.insertImage(nativePath);
      const src = await resolveStoredImageSrc(asset, file);

      if (src) {
        return {
          src,
          alt: asset.title,
          title: asset.title,
          path: asset.path,
          mimeType: asset.mimeType,
          documentId: asset.documentId,
        };
      }
    } catch {
      // Fall through to a data URL so pasted screenshots still work.
    }
  }

  const src = await readFileAsDataUrl(file);
  const title = file.name?.trim() || "粘贴图片";

  return {
    src,
    alt: title,
    title,
    mimeType: file.type || undefined,
  };
}

function insertImageAtSelection(view: EditorView, attrs: Record<string, unknown>) {
  const imageType = view.state.schema.nodes.image;
  const paragraphType = view.state.schema.nodes.paragraph;

  if (!imageType || !paragraphType) {
    return;
  }

  const tr = view.state.tr;

  ensureInsertionCursor({ tr });

  const imageNode = imageType.create(attrs);

  tr.replaceSelectionWith(imageNode, false);

  const paragraphPos = tr.selection.to;

  tr.insert(paragraphPos, paragraphType.create());
  tr.setSelection(TextSelection.create(tr.doc, paragraphPos + 1));
  view.dispatch(tr.scrollIntoView());
}

function focusEmptyEditorSelection(view: EditorView) {
  const firstNode = view.state.doc.firstChild;
  const isSingleEmptyParagraph =
    view.state.doc.childCount === 1 &&
    firstNode?.type.name === "paragraph" &&
    firstNode.content.size === 0;

  if (!isSingleEmptyParagraph) {
    return;
  }

  view.focus();
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)),
  );
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(reader.error ?? new Error("读取粘贴图片失败"));
    };
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("读取粘贴图片失败"));
    };

    reader.readAsDataURL(file);
  });
}

async function resolveStoredImageSrc(asset: RichEditorAsset, file?: File) {
  const normalizedSrc = typeof asset.src === "string" ? asset.src.trim() : "";

  if (normalizedSrc.startsWith("data:") || normalizedSrc.startsWith("blob:")) {
    return normalizedSrc;
  }

  if (asset.path) {
    try {
      return await desktopApi.readFileAsDataUrl(asset.path, asset.mimeType);
    } catch {
      const fallbackSrc = resolveRichTextImageSrc(asset.path, asset.src);

      if (fallbackSrc) {
        return fallbackSrc;
      }
    }
  }

  if (file) {
    try {
      return await readFileAsDataUrl(file);
    } catch {
      // Fall through to any existing src below.
    }
  }

  return resolveRichTextImageSrc(asset.path, asset.src);
}

function extractClipboardImageFiles(clipboardData?: DataTransfer | null) {
  const directFiles = Array.from(clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );

  if (directFiles.length > 0) {
    return directFiles;
  }

  const itemFiles = Array.from(clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  return dedupeFiles(itemFiles);
}

function dedupeFiles(files: File[]) {
  const seen = new Set<string>();

  return files.filter((file) => {
    const key = [
      file.name,
      file.type,
      file.size,
      String((file as File & { path?: string }).path ?? ""),
    ].join("::");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function shouldHandlePastedHtml(rawHtml: string, options: { allowTables: boolean }) {
  const normalized = rawHtml.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  if (normalized.includes("<img")) {
    return true;
  }

  return options.allowTables && normalized.includes("<table");
}

function shouldHandlePastedMarkdown(rawText: string) {
  const normalized = rawText.trim();

  if (!normalized) {
    return false;
  }

  return (
    /(^|\n)\s{0,3}#{1,6}\s+\S/u.test(normalized) ||
    /(^|\n)\s*[-*+]\s+\S/u.test(normalized) ||
    /(^|\n)\s*\d+\.\s+\S/u.test(normalized) ||
    /(^|\n)>\s+\S/u.test(normalized) ||
    /(^|\n)\|.+\|\s*\n\|[\s:|-]+\|/u.test(normalized) ||
    /```[\s\S]*```/u.test(normalized)
  );
}

async function buildPastedHtml(
  rawHtml: string,
  assetHandlers?: RichEditorAssetHandlers,
) {
  if (!rawHtml || typeof DOMParser === "undefined") {
    return null;
  }

  const sanitizedHtml = sanitizePastedHtml(rawHtml);
  const doc = new DOMParser().parseFromString(sanitizedHtml, "text/html");
  const images = Array.from(doc.body.querySelectorAll("img"));
  const hasTable = doc.body.querySelector("table") !== null;

  if (images.length === 0 && !hasTable) {
    return null;
  }

  for (const [index, image] of images.entries()) {
    const replacement = await buildPastedImageElement(doc, image, index, assetHandlers);

    if (replacement) {
      image.replaceWith(replacement);
    }
  }

  appendTrailingParagraphIfNeeded(doc);

  return doc.body.innerHTML.trim();
}

async function buildPastedImageElement(
  doc: Document,
  image: Element,
  index: number,
  assetHandlers?: RichEditorAssetHandlers,
) {
  const source = image.getAttribute("src")?.trim() ?? "";

  if (!source) {
    return null;
  }

  const title = resolvePastedImageTitle(image, index, source);
  const mimeType = inferImageMimeType(source);
  const file = buildClipboardImageFile(source, title, mimeType);

  if (file) {
    const attrs = await buildPastedImageAttrs(file, assetHandlers);

    return attrs ? createPastedImageElement(doc, attrs) : null;
  }

  const nativePath = resolveClipboardImagePath(source);

  if (nativePath && assetHandlers?.insertImage) {
    try {
      const asset = await assetHandlers.insertImage(nativePath);
      const src = await resolveStoredImageSrc(asset);

      if (src) {
        return createPastedImageElement(doc, {
          src,
          alt: asset.title,
          title: asset.title,
          path: asset.path,
          mimeType: asset.mimeType,
          documentId: asset.documentId,
        });
      }
    } catch {
      // Fall through to a best-effort local image reference.
    }
  }

  return createPastedImageElement(doc, {
    src: resolveRichTextImageSrc(nativePath, source) ?? source,
    alt: title,
    title,
    path: nativePath ?? undefined,
    mimeType: mimeType ?? undefined,
  });
}

function resolvePastedImageTitle(image: Element, index: number, source: string) {
  const preferredTitle =
    image.getAttribute("title")?.trim() ||
    image.getAttribute("alt")?.trim() ||
    image.getAttribute("data-filename")?.trim();

  if (preferredTitle) {
    return preferredTitle;
  }

  const sourcePath = resolveClipboardImagePath(source);

  if (sourcePath) {
    const fileName = sourcePath.split(/[\\/]/).pop()?.trim();

    if (fileName) {
      return fileName;
    }
  }

  return `clipboard-image-${index + 1}.${extensionForMimeType(inferImageMimeType(source) ?? "image/png")}`;
}

function buildClipboardImageFile(source: string, title: string, mimeType?: string | null) {
  if (!source.startsWith("data:")) {
    return null;
  }

  const parsed = parseDataUrl(source);

  if (!parsed || !parsed.mimeType.startsWith("image/")) {
    return null;
  }

  return new File([parsed.bytes], normalizeImageFileName(title, parsed.mimeType), {
    type: parsed.mimeType,
  });
}

function parseDataUrl(source: string) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(source.trim());

  if (!match) {
    return null;
  }

  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return {
      mimeType: match[1]?.trim().toLowerCase() || "application/octet-stream",
      bytes,
    };
  } catch {
    return null;
  }
}

function normalizeImageFileName(title: string, mimeType: string) {
  const trimmed = title.trim();

  if (trimmed && /\.[A-Za-z0-9]{2,5}$/.test(trimmed)) {
    return trimmed;
  }

  const baseName = trimmed || "clipboard-image";

  return `${baseName}.${extensionForMimeType(mimeType)}`;
}

function inferImageMimeType(source: string) {
  const dataUrlMatch = /^data:([^;,]+)[;,]/i.exec(source.trim());

  if (dataUrlMatch) {
    return dataUrlMatch[1]?.trim().toLowerCase() || null;
  }

  const normalized = source.toLowerCase();

  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (normalized.endsWith(".gif")) {
    return "image/gif";
  }

  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }

  if (normalized.endsWith(".svg")) {
    return "image/svg+xml";
  }

  if (normalized.endsWith(".bmp")) {
    return "image/bmp";
  }

  if (normalized.endsWith(".avif")) {
    return "image/avif";
  }

  if (normalized.endsWith(".heic")) {
    return "image/heic";
  }

  if (normalized.endsWith(".heif")) {
    return "image/heif";
  }

  if (normalized.endsWith(".png")) {
    return "image/png";
  }

  return null;
}

function resolveClipboardImagePath(source: string) {
  const trimmed = source.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("file:")) {
    const filePath = fileUriToPath(trimmed);

    return filePath || null;
  }

  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || /^[/\\]{2}[^/\\]/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function createPastedImageElement(doc: Document, attrs: {
  src?: string;
  alt?: string;
  title?: string;
  path?: string;
  mimeType?: string;
  documentId?: number;
}) {
  const element = doc.createElement("img");

  if (attrs.src) {
    element.setAttribute("src", attrs.src);
  }

  if (attrs.alt) {
    element.setAttribute("alt", attrs.alt);
  }

  if (attrs.title) {
    element.setAttribute("title", attrs.title);
  }

  if (attrs.path) {
    element.setAttribute("data-path", attrs.path);
  }

  if (attrs.mimeType) {
    element.setAttribute("data-mime-type", attrs.mimeType);
  }

  if (typeof attrs.documentId === "number") {
    element.setAttribute("data-document-id", String(attrs.documentId));
  }

  return element;
}

function appendTrailingParagraphIfNeeded(doc: Document) {
  const lastElement = doc.body.lastElementChild;

  if (!lastElement) {
    return;
  }

  if (lastElement.tagName === "IMG" || lastElement.tagName === "TABLE") {
    doc.body.appendChild(doc.createElement("p"));
  }
}

function createSyntheticPasteEvent() {
  if (typeof ClipboardEvent !== "undefined") {
    return new ClipboardEvent("paste");
  }

  const event = new Event("paste") as ClipboardEvent;

  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: {
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      getData: () => "",
    } satisfies Pick<DataTransfer, "files" | "items" | "getData">,
  });

  return event;
}

function extensionForMimeType(mimeType: string) {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    case "image/avif":
      return "avif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "png";
  }
}
