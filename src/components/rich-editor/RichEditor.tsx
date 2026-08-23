import { Suspense, forwardRef, lazy, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createDocument, type Editor, type JSONContent } from "@tiptap/core";
import { DOMSerializer, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Bold,
  ChevronDown,
  ChevronUp,
  Code2,
  Columns2,
  Combine,
  Copy,
  ExternalLink,
  File as FileIcon,
  FolderOpen,
  Grid2X2Plus,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image,
  ImageUp,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  LoaderCircle,
  Lightbulb,
  Maximize2,
  Minus,
  MoreHorizontal,
  Paperclip,
  PanelLeft,
  PanelTop,
  Pencil,
  Pilcrow,
  Quote,
  Rows2,
  Scissors,
  Settings2,
  Sparkles,
  Star,
  Split,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";

import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import { isAiCapabilityConfigured } from "../../lib/ai";
import {
  buildContactMentionTarget,
  findContactMentionElement,
  findContactMentionTextTrigger,
  readContactMentionElement,
  setContactMentionElementBroken,
} from "../../lib/contactMentions";
import {
  aiEditorSkillJobTargetKey,
  editorSkillJobInput,
  ensureAiJobSync,
  readEditorSkillJobResult,
} from "../../lib/aiJobs";
import { fileUriToPath } from "../../lib/formatters";
import {
  buildInternalReferenceTarget,
  findInternalReferenceElement,
  findInternalReferenceTextTrigger,
  readInternalReferenceElement,
  setInternalReferenceElementBroken,
} from "../../lib/internalReferences";
import { findHashTagTextTrigger } from "../../lib/tags";
import { repairRichTextAssetHtml, resolveRichTextImageSrc } from "../../lib/richTextAssets";
import {
  renderMarkdownToHtml,
  richTextHtmlToPlainText,
  trimTrailingCodeBlockNewline,
} from "../../lib/richTextContent";
import type {
  AiEditorSkillContext,
  AiEditorSkillResultMode,
  AiSettingsSnapshot,
  ContactRecord,
  ProjectTagRecord,
  InternalReferenceSearchResult,
} from "../../lib/types";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useAiJobStore } from "../../state/ai-job-store";
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
import { TagMentionPicker, useTagMentionSearch } from "../tags/TagMentionPicker";
import {
  buildEditorRewriteSelection,
  buildEditorRewriteSlice,
  type EditorRewritePlaceholder,
} from "./editorRewrite";
import {
  EDITOR_REWRITE_PROTECTION_PLUGIN_KEY,
  createEditorRewriteProtectionPlugin,
  getEditorRewriteProtectedRange,
  markEditorRewriteTransaction,
  setEditorRewriteProtectedRange,
} from "./editorRewriteProtection";
import {
  codeLanguageLabel,
  filterCodeLanguageOptions,
  normalizeCodeLanguage,
} from "./codeHighlight";
import { RichEditorAiMenu } from "./RichEditorAiMenu";
import { RichEditorRewriteWidget } from "./RichEditorRewriteWidget";
import { buildRichEditorExtensions, RICH_EDITOR_CODE_LANGUAGE_OPEN_EVENT } from "./extensions";
import {
  EMPTY_RICH_EDITOR_HTML,
  serializeEditorMarkdown,
  serializeRichTextNodesMarkdown,
} from "./markdown";
import { normalizeRichEditorValue } from "./normalize";
import {
  createEditorSearchPlugin,
  editorSearchMatchesEqual,
  findEditorSearchMatches,
  RICH_EDITOR_SEARCH_PLUGIN_KEY,
  scrollSearchMatchIntoComfortView,
  type EditorSearchMatch,
} from "./editorSearch";

const ImageAnnotationDialog = lazy(() =>
  import("./ImageAnnotationDialog").then((module) => ({
    default: module.ImageAnnotationDialog,
  })),
);
import type {
  RichEditorAsset,
  RichEditorAssetHandlers,
  RichEditorAutoFocusPoint,
  RichEditorContactMentionOptions,
  RichEditorInternalReferenceOptions,
  RichEditorPersistState,
  RichEditorTagMentionOptions,
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
const CHANGE_PUBLISH_DELAY_MS = 120;
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
  targetType: "text" | "image";
  imageTarget?: ImageContextMenuTarget;
}

interface TableToolbarPosition {
  left: number;
  top: number;
}

interface CodeToolbarPosition {
  left: number;
  top: number;
}

interface ActiveCodeBlockInfo {
  pos: number;
  language: string;
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

interface AttachmentContextMenuTarget {
  nodePos: number;
  attrs: {
    documentId?: number;
    href?: string;
    isStarred?: boolean;
    meta?: string;
    mimeType?: string;
    path?: string;
    title?: string;
  };
}

interface ImageAnnotationDialogState {
  nodePos: number;
  title: string;
  imageSrc: string;
  fallbackImageSrc?: string;
  annotationState?: string | null;
  imageSize?: {
    width?: number;
    height?: number;
  };
}

interface StoredTextSelection {
  from: number;
  to: number;
}

interface EditorAiSelectionSnapshot {
  from: number;
  to: number;
  text: string;
  markdown: string;
  placeholders: EditorRewritePlaceholder[];
  originalSlice: Slice;
}

interface EditorAiSkillSnapshot {
  id?: string | null;
  name: string;
  prompt: string;
  resultMode: AiEditorSkillResultMode;
}

interface EditorAiModifyPreview {
  originalMarkdown: string;
  modifiedMarkdown: string;
  placeholders: EditorRewritePlaceholder[];
  originalSlice: Slice;
  currentFrom: number;
  currentTo: number;
  showing: "original" | "modified";
}

interface EditorSkillSessionState {
  targetKey: string;
  skill: EditorAiSkillSnapshot;
  selectionSnapshot: EditorAiSelectionSnapshot;
  anchorPos: number;
  modifyPreview?: EditorAiModifyPreview | null;
  answer?: string | null;
  modificationResolved?: boolean;
  targetType: "text" | "image";
  imageTarget?: ImageContextMenuTarget;
  resolvedModel?: string | null;
  resolvedProfileName?: string | null;
  usedDefaultFallback?: boolean;
  jobId?: number | null;
  contextKey: string;
  contextStale?: boolean;
  parseError?: string | null;
}

type EditorSkillDisplayStatus = "queued" | "running" | "succeeded" | "failed";

interface EditorSkillWidgetState {
  skillName: string;
  anchorPos: number;
  resultMode: AiEditorSkillResultMode;
  status: EditorSkillDisplayStatus;
  answer?: string | null;
  answerHtml?: string | null;
  modifyPreview?: EditorAiModifyPreview | null;
  errorMessage?: string | null;
  resolvedModel?: string | null;
  resolvedProfileName?: string | null;
  usedDefaultFallback?: boolean;
  contextStale?: boolean;
  parseError?: string | null;
}


interface RichEditorProps {
  html?: string;
  defaultHtml?: string;
  variant?: RichEditorVariant;
  showToolbar?: boolean;
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
  onSnapshot?: (value: RichEditorValue) => void;
  onDirtyChange?: (dirty: boolean) => void;
  controllerRef?: MutableRefObject<RichEditorController | null>;
  onSave?: (value: RichEditorValue) => Promise<unknown> | unknown;
  onPersistStateChange?: (state: RichEditorPersistState) => void;
  onBlurPersisted?: (result: unknown) => void;
  onModEnter?: () => Promise<unknown> | unknown;
  onOpenAsset?: (asset: RichEditorAsset) => void | Promise<void>;
  internalReferences?: RichEditorInternalReferenceOptions;
  contactMentions?: RichEditorContactMentionOptions;
  tagMentions?: RichEditorTagMentionOptions;
  aiSettings?: AiSettingsSnapshot | null;
  aiRewriteContext?: AiEditorSkillContext;
  onOpenAiSettings?: () => void;
  selectionActions?: RichEditorSelectionAction[];
  renderToolbarExtras?: (context: {
    persistState: RichEditorPersistState;
    save: (options?: { force?: boolean }) => Promise<unknown>;
  }) => ReactNode;
  defaultCodeLanguage?: string | null;
  onDefaultCodeLanguageChange?: (language: string | null) => void;
}

export interface RichEditorSelectionPayload {
  text: string;
  markdown: string;
  html: string;
  removeSelectionAndSave: () => Promise<unknown>;
}

export interface RichEditorController {
  getValue: () => RichEditorValue;
  getCommittedValue: () => RichEditorValue;
  getDocumentJson: () => JSONContent;
  getActiveAiProtectionCount: () => number;
  focus: (position?: "start" | "end" | number | RichEditorAutoFocusPoint) => void;
  save: (options?: { force?: boolean }) => Promise<unknown> | undefined;
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
  showToolbar = true,
  placeholder = "输入内容，Markdown 会即时渲染为富文本。",
  readOnly = false,
  autoFocus = false,
  enableTables = true,
  autosave = false,
  shouldPersistOnBlur,
  assetHandlers,
  onChange,
  onSnapshot,
  onDirtyChange,
  controllerRef,
  onSave,
  onPersistStateChange,
  onBlurPersisted,
  onModEnter,
  onOpenAsset,
  internalReferences,
  contactMentions,
  tagMentions,
  aiSettings,
  aiRewriteContext,
  onOpenAiSettings,
  selectionActions,
  renderToolbarExtras,
  defaultCodeLanguage,
  onDefaultCodeLanguageChange,
}: RichEditorProps) {
  const { pushToast } = useFeedbackStore();
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [isFocused, setIsFocused] = useState(false);
  const [assetBusy, setAssetBusy] = useState<null | "image" | "file">(null);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [aiMenu, setAiMenu] = useState<EditorAiMenuState | null>(null);
  const [annotationDialog, setAnnotationDialog] = useState<ImageAnnotationDialogState | null>(null);
  const [rewriteSessions, setRewriteSessions] = useState<EditorSkillSessionState[]>([]);
  const rewriteSession = rewriteSessions[rewriteSessions.length - 1] ?? null;
  const setRewriteSession = useCallback((
    update: EditorSkillSessionState | null | ((current: EditorSkillSessionState | null) => EditorSkillSessionState | null),
  ) => {
    setRewriteSessions((current) => {
      const active = current[current.length - 1] ?? null;
      const next = typeof update === "function" ? update(active) : update;
      if (!next) return active ? current.slice(0, -1) : current;
      return active ? [...current.slice(0, -1), next] : [next];
    });
  }, []);
  const updateRewriteSessionByTarget = useCallback((
    targetKey: string,
    update: (session: EditorSkillSessionState) => EditorSkillSessionState | null,
  ) => {
    setRewriteSessions((current) => current.flatMap((session) => {
      if (session.targetKey !== targetKey) return [session];
      const next = update(session);
      return next ? [next] : [];
    }));
  }, []);
  const [uiTick, setUiTick] = useState(0);
  const [tableToolbarPosition, setTableToolbarPosition] = useState<TableToolbarPosition | null>(null);
  const [codeToolbarPosition, setCodeToolbarPosition] = useState<CodeToolbarPosition | null>(null);
  const [codeLanguagePanelOpen, setCodeLanguagePanelOpen] = useState(false);
  const [codeLanguageContextMenuOpen, setCodeLanguageContextMenuOpen] = useState(false);
  const [codeLanguageQuery, setCodeLanguageQuery] = useState("");
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
  const [tagPicker, setTagPicker] = useState<null | {
    start: number;
    end: number;
    query: string;
    position: { left: number; top: number };
  }>(null);
  const [tagActiveIndex, setTagActiveIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<EditorSearchMatch[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [controlledHtmlReconcileGeneration, setControlledHtmlReconcileGeneration] = useState(0);

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
  const blurPersistTimerRef = useRef<number | null>(null);
  const changePublishTimerRef = useRef<number | null>(null);
  const deferredUiFrameRef = useRef<number | null>(null);
  const deferredUiEditorRef = useRef<Editor | null>(null);
  const deferredUiNeedsChromeRefreshRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const saveCycleRef = useRef<{
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    error: unknown;
  } | null>(null);
  const assetBusyRef = useRef<null | "image" | "file">(null);
  const taskShortcutTransformRef = useRef(false);
  const aiPreviewMutationRef = useRef(false);
  const autoFocusAppliedRef = useRef(false);
  const lastPersistedHtmlRef = useRef(normalizeHtml(html ?? defaultHtml));
  const lastResolvedHtmlRef = useRef(normalizeHtml(html ?? defaultHtml));
  const pendingChangeSnapshotRef = useRef<RichEditorValue | null>(null);
  const isFocusedRef = useRef(false);
  const persistStateRef = useRef<RichEditorPersistState>("idle");
  const dirtyStateRef = useRef(false);
  const syntheticPasteRef = useRef(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const tableToolbarRef = useRef<HTMLDivElement | null>(null);
  const codeToolbarRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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
  const tagPickerRef = useRef<null | {
    start: number;
    end: number;
    query: string;
    position: { left: number; top: number };
  }>(null);
  const tagActiveIndexRef = useRef(0);
  const tagResultsRef = useRef<ProjectTagRecord[]>([]);
  const rewriteSessionRef = useRef<EditorSkillSessionState | null>(null);
  const rewriteSessionsRef = useRef<EditorSkillSessionState[]>([]);
  const editorSkillJobIdsRef = useRef(new Map<string, number>());
  const internalEditorCommitInFlightRef = useRef(false);
  const abandonedEditorSkillTargetsRef = useRef(new Set<string>());
  const rewriteWidgetStateRef = useRef<EditorSkillWidgetState | null>(null);
  const rewriteWidgetCallbacksRef = useRef<{
    onAccept: () => void;
    onReject: () => void;
    onCompareDown: () => void;
    onCompareUp: () => void;
    onRetry: () => void;
    onCopyAnswer: () => void;
    onInsertAnswer: () => void;
    onPreserveViewport: () => void;
    onClose: () => void;
    onOpenAiSettings?: () => void;
  }>({
    onAccept: () => {},
    onReject: () => {},
    onCompareDown: () => {},
    onCompareUp: () => {},
    onRetry: () => {},
    onCopyAnswer: () => {},
    onInsertAnswer: () => {},
    onPreserveViewport: () => {},
    onClose: () => {},
    onOpenAiSettings: undefined,
  });
  rewriteSessionRef.current = rewriteSession;
  rewriteSessionsRef.current = rewriteSessions;
  const synchronizeResolvedRewriteSession = (
    targetKey: string,
    nextSession: EditorSkillSessionState | null,
  ) => {
    const nextSessions = rewriteSessionsRef.current.flatMap((session) =>
      session.targetKey === targetKey
        ? (nextSession ? [nextSession] : [])
        : [session],
    );
    rewriteSessionsRef.current = nextSessions;
    rewriteSessionRef.current = nextSessions[nextSessions.length - 1] ?? null;
  };
  const searchStateRef = useRef<{
    open: boolean;
    matches: EditorSearchMatch[];
    activeIndex: number;
  }>({
    open: false,
    matches: [],
    activeIndex: 0,
  });
  const aiJobsById = useAiJobStore((state) => state.jobsById);
  const latestAiJobIdByTarget = useAiJobStore((state) => state.latestJobIdByTarget);
  const rewriteJobId = rewriteSession ? latestAiJobIdByTarget[rewriteSession.targetKey] : null;
  const rewriteJob = rewriteJobId ? aiJobsById[rewriteJobId] ?? null : null;
  const enabledEditorSkills = useMemo(
    () =>
      (aiSettings?.editorSkills ?? [])
        .filter((skill) => skill.enabled && skill.showInTextMenu)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-Hans-CN")),
    [aiSettings?.editorSkills],
  );
  const enabledImageSkills = useMemo(
    () =>
      (aiSettings?.editorSkills ?? [])
        .filter((skill) => skill.enabled && skill.showInImageMenu)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-Hans-CN")),
    [aiSettings?.editorSkills],
  );
  const editorRewriteVisible = Boolean(aiSettings);
  const editorRewriteReady =
    Boolean(aiSettings) && (aiSettings?.hasUsableDefault || isAiCapabilityConfigured(aiSettings ?? undefined, "default"));
  const imageInterpretationReady =
    Boolean(aiSettings) && (aiSettings?.hasUsableImageDefault || isAiCapabilityConfigured(aiSettings ?? undefined, "image_default"));
  const aiModifySessionActive =
    rewriteSessions.some((session) => session.skill.resultMode === "modify" || session.skill.resultMode === "auto");
  const effectiveReadOnly = readOnly;
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
    async (view: EditorView, files: File[], restoreTarget?: () => boolean) => {
      let inserted = false;
      const preparedImages: Record<string, unknown>[] = [];

      for (const file of files) {
        const imageAttrs = await buildPastedImageAttrs(file, assetHandlers);

        if (!imageAttrs) {
          continue;
        }

        preparedImages.push(imageAttrs);
      }

      if (preparedImages.length === 0 || (restoreTarget && !restoreTarget())) {
        return false;
      }

      for (const imageAttrs of preparedImages) {
        focusEmptyEditorSelection(view);
        insertImageAtSelection(view, imageAttrs);
        inserted = true;
      }

      return inserted;
    },
    [assetHandlers],
  );

  const handlePastedHtml = useCallback(
    async (view: EditorView, rawHtml: string, restoreTarget?: () => boolean) => {
      const nextHtml = await buildPastedHtml(rawHtml, assetHandlers);

      if (!nextHtml || (restoreTarget && !restoreTarget())) {
        return false;
      }

      focusEmptyEditorSelection(view);
      syntheticPasteRef.current = true;
      view.pasteHTML(nextHtml, createSyntheticPasteEvent());
      return true;
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
  const { results: tagResults, loading: tagLoading } = useTagMentionSearch({
    open: Boolean(tagPicker),
    query: tagPicker?.query ?? "",
    projectId: tagMentions?.projectId,
    availableTags: tagMentions?.availableTags,
    limit: 8,
  });

  referencePickerRef.current = referencePicker;
  referenceActiveIndexRef.current = referenceActiveIndex;
  referenceResultsRef.current = referenceResults;
  mentionPickerRef.current = mentionPicker;
  mentionActiveIndexRef.current = mentionActiveIndex;
  mentionResultsRef.current = mentionResults;
  tagPickerRef.current = tagPicker;
  tagActiveIndexRef.current = tagActiveIndex;
  tagResultsRef.current = tagResults;

  const mentionsEnabled = Boolean(contactMentions);
  const tagMentionsEnabled = typeof tagMentions !== "undefined";
  const tagCreateLabel = tagPicker?.query.trim() ?? "";
  const tagCreatable =
    tagMentionsEnabled &&
    Boolean(tagMentions?.onCreateTag) &&
    tagCreateLabel.length > 0 &&
    !tagResults.some((tag) => tag.label.toLocaleLowerCase("zh-Hans-CN") === tagCreateLabel.toLocaleLowerCase("zh-Hans-CN"));
  const tagOptionCount = tagResults.length + (tagCreatable ? 1 : 0);
  const mentionCreatable =
    mentionsEnabled &&
    Boolean(contactMentions?.onCreateContact) &&
    (mentionPicker?.query.trim().length ?? 0) > 0;
  // The create row, when present, sits just past the search hits.
  const mentionOptionCount = mentionResults.length + (mentionCreatable ? 1 : 0);
  const shouldRefreshEditorChrome =
    showToolbar ||
    enableTables ||
    contextMenu !== null ||
    aiMenu !== null ||
    searchOpen;

  searchStateRef.current = {
    open: searchOpen,
    matches: searchMatches,
    activeIndex: activeSearchIndex,
  };

  const closeInternalReferencePicker = useCallback(() => {
    setReferencePicker(null);
    setReferenceActiveIndex(0);
  }, []);

  const openEditorSearch = useCallback(() => {
    setSearchOpen(true);
    setContextMenu(null);
    setAiMenu(null);
    window.requestAnimationFrame(() => {
      const input = searchInputRef.current;

      input?.focus();
      if (input && input.value.length === 0) {
        input.select();
      }
    });
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

  const closeTagPicker = useCallback(() => {
    setTagPicker(null);
    setTagActiveIndex(0);
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

  const syncTagPicker = useCallback(
    (nextEditor: Editor | null) => {
      if (!nextEditor || effectiveReadOnly || !tagMentionsEnabled) {
        closeTagPicker();
        return;
      }

      const nextTrigger = resolveEditorTagTrigger(nextEditor, frameRef.current);

      setTagPicker((current) => {
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
    [closeTagPicker, effectiveReadOnly, tagMentionsEnabled],
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

  const handleSelectTagMention = useCallback(
    (view: EditorView, tag: ProjectTagRecord) => {
      const trigger = tagPickerRef.current;
      if (!trigger) {
        return false;
      }

      insertTagMentionNode(view, trigger, tag);
      closeTagPicker();
      return true;
    },
    [closeTagPicker],
  );

  const handleCreateTagMention = useCallback(
    (view: EditorView, label: string) => {
      const trigger = tagPickerRef.current;
      const createTag = tagMentions?.onCreateTag;

      if (!trigger || !createTag || !label.trim()) {
        return false;
      }

      void Promise.resolve(createTag(label.trim())).then((createdTag) => {
        if (createdTag) {
          insertTagMentionNode(view, trigger, createdTag);
        }
      });
      closeTagPicker();
      return true;
    },
    [closeTagPicker, tagMentions?.onCreateTag],
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
    if (!tagPicker) {
      setTagActiveIndex(0);
      return;
    }

    setTagActiveIndex((current) => {
      if (tagResults.length === 0) {
        return 0;
      }

      return Math.min(current, tagResults.length - 1);
    });
  }, [tagPicker, tagResults.length]);

  useEffect(() => {
    if (!tagPicker) {
      return;
    }

    setTagActiveIndex(0);
  }, [tagPicker?.query]);

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
      const nextDirty = nextState === "dirty" || nextState === "saving";

      if (dirtyStateRef.current !== nextDirty) {
        dirtyStateRef.current = nextDirty;
        onDirtyChange?.(nextDirty);
      }

      setPersistState(nextState);
      onPersistStateChange?.(nextState);
    },
    [onDirtyChange, onPersistStateChange],
  );

  const clearChangePublishTimer = useCallback(() => {
    if (changePublishTimerRef.current !== null) {
      window.clearTimeout(changePublishTimerRef.current);
      changePublishTimerRef.current = null;
    }
  }, []);

  const publishChangeSnapshot = useCallback(
    (
      snapshot: RichEditorValue,
      options?: {
        immediate?: boolean;
        sync?: boolean;
      },
    ) => {
      pendingChangeSnapshotRef.current = snapshot;

      const commit = () => {
        const nextSnapshot = pendingChangeSnapshotRef.current;

        clearChangePublishTimer();

        if (!nextSnapshot) {
          return;
        }

        pendingChangeSnapshotRef.current = null;

        const notify = () => {
          onChange?.(nextSnapshot);
          onSnapshot?.(nextSnapshot);
        };

        if (options?.sync) {
          flushSync(notify);
        } else {
          startTransition(notify);
        }
      };

      if (options?.immediate || options?.sync) {
        commit();
        return;
      }

      clearChangePublishTimer();
      changePublishTimerRef.current = window.setTimeout(() => {
        commit();
      }, CHANGE_PUBLISH_DELAY_MS);
    },
    [clearChangePublishTimer, onChange, onSnapshot],
  );

  const scheduleChangeSnapshot = useCallback(
    (snapshotEditor: Editor) => {
      if (!onChange && !onSnapshot) {
        return;
      }

      clearChangePublishTimer();
      changePublishTimerRef.current = window.setTimeout(() => {
        if (snapshotEditor.isDestroyed) {
          changePublishTimerRef.current = null;
          return;
        }

        const snapshot = serializeEditor(snapshotEditor);

        lastResolvedHtmlRef.current = snapshot.html;
        publishChangeSnapshot(snapshot, { immediate: true });
      }, CHANGE_PUBLISH_DELAY_MS);
    },
    [clearChangePublishTimer, onChange, onSnapshot, publishChangeSnapshot],
  );

  const clearDeferredUiFrame = useCallback(() => {
    if (deferredUiFrameRef.current !== null) {
      window.cancelAnimationFrame(deferredUiFrameRef.current);
      deferredUiFrameRef.current = null;
    }
  }, []);

  const flushDeferredEditorUi = useCallback(() => {
    deferredUiFrameRef.current = null;
    const nextEditor = deferredUiEditorRef.current;

    if (!nextEditor) {
      return;
    }

    if (deferredUiNeedsChromeRefreshRef.current && shouldRefreshEditorChrome) {
      startTransition(() => {
        setUiTick((tick) => tick + 1);
      });
    }

    deferredUiNeedsChromeRefreshRef.current = false;
    syncInternalReferencePicker(nextEditor);
    syncContactMentionPicker(nextEditor);
    syncTagPicker(nextEditor);
  }, [
    shouldRefreshEditorChrome,
    syncContactMentionPicker,
    syncInternalReferencePicker,
    syncTagPicker,
  ]);

  const scheduleDeferredEditorUi = useCallback(
    (nextEditor: Editor, options?: { refreshChrome?: boolean }) => {
      deferredUiEditorRef.current = nextEditor;
      deferredUiNeedsChromeRefreshRef.current =
        deferredUiNeedsChromeRefreshRef.current || Boolean(options?.refreshChrome);

      if (deferredUiFrameRef.current !== null) {
        return;
      }

      deferredUiFrameRef.current = window.requestAnimationFrame(() => {
        flushDeferredEditorUi();
      });
    },
    [flushDeferredEditorUi],
  );

  const editorExtensions = useMemo(
    () => buildRichEditorExtensions(placeholder),
    [placeholder],
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: !effectiveReadOnly,
    extensions: editorExtensions,
    content: normalizeHtml(html ?? defaultHtml),
    editorProps: {
      attributes: {
        class: "rich-editor__surface",
      },
      clipboardTextSerializer: (content, view) => serializeRichTextClipboard(content, view),
      transformPastedHTML: (rawHtml) => sanitizePastedHtml(rawHtml),
      handleDOMEvents: {
        copy: (view, event) => handleEditorClipboardEvent(view, event, "copy", effectiveReadOnly),
        cut: (view, event) => handleEditorClipboardEvent(view, event, "cut", effectiveReadOnly),
      },
      handlePaste: (view, event) => {
        if (syntheticPasteRef.current) {
          syntheticPasteRef.current = false;
          return false;
        }

        if (effectiveReadOnly) {
          return false;
        }

        const rawHtml = event.clipboardData?.getData("text/html") ?? "";
        const rawText = event.clipboardData?.getData("text/plain") ?? "";
        const imageFiles = extractClipboardImageFiles(event.clipboardData);

        if (hasMeaningfulPastedHtml(rawHtml)) {
          event.preventDefault();

          if (shouldHandlePastedHtml(rawHtml, { allowTables: enableTables })) {
            void handlePastedHtml(view, rawHtml).catch(() => {
              const fallbackHtml = buildImageFreePastedHtmlFallback(rawHtml);

              if (!fallbackHtml) {
                return;
              }

              syntheticPasteRef.current = true;
              view.pasteHTML(fallbackHtml, createSyntheticPasteEvent());
            });
          } else {
            syntheticPasteRef.current = true;
            view.pasteHTML(sanitizePastedHtml(rawHtml), createSyntheticPasteEvent());
          }
          return true;
        }

        if (imageFiles.length > 0) {
          event.preventDefault();
          void handlePastedImages(view, imageFiles).catch(() => {
            // The caller owns error presentation.
          });
          return true;
        }

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
          const fallbackHtml = buildImageFreePastedHtmlFallback(rawHtml);

          if (!fallbackHtml) {
            return;
          }

          syntheticPasteRef.current = true;
          view.pasteHTML(fallbackHtml, createSyntheticPasteEvent());
        });
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (!event.isComposing && event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          openEditorSearch();
          return true;
        }

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

        const activeTagPicker = tagPickerRef.current;

        if (!effectiveReadOnly && activeTagPicker) {
          if (event.key === "Escape") {
            event.preventDefault();
            closeTagPicker();
            return true;
          }

          if (event.key === "ArrowDown" && tagOptionCount > 0) {
            event.preventDefault();
            setTagActiveIndex((current) => (current + 1) % tagOptionCount);
            return true;
          }

          if (event.key === "ArrowUp" && tagOptionCount > 0) {
            event.preventDefault();
            setTagActiveIndex((current) =>
              current === 0 ? tagOptionCount - 1 : current - 1,
            );
            return true;
          }

          if (event.key === "Enter" && tagOptionCount > 0) {
            event.preventDefault();
            const activeIndex = Math.max(
              0,
              Math.min(tagActiveIndexRef.current, tagOptionCount - 1),
            );

            if (tagCreatable && activeIndex === tagResultsRef.current.length) {
              return handleCreateTagMention(_view, tagCreateLabel);
            }

            return handleSelectTagMention(
              _view,
              tagResultsRef.current[
                Math.max(0, Math.min(activeIndex, tagResultsRef.current.length - 1))
              ],
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
          const currentEditor = editor;

          if (currentEditor && resolveActiveListItemType(currentEditor)) {
            event.preventDefault();
            handleListIndentation(currentEditor, event.shiftKey);
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
      isFocusedRef.current = true;
      setIsFocused(true);
      rememberCurrentTextSelection(nextEditor);
      scheduleDeferredEditorUi(nextEditor, { refreshChrome: true });
    },
    onBlur: ({ editor: nextEditor }) => {
      isFocusedRef.current = false;
      setIsFocused(false);
      clearChangePublishTimer();
      if (onChange || onSnapshot) {
        aiPreviewMutationRef.current = true;
        let snapshot: RichEditorValue;
        try {
          snapshot = serializeCommittedEditor(nextEditor, rewriteSessionsRef.current);
        } finally {
          aiPreviewMutationRef.current = false;
        }
        lastResolvedHtmlRef.current = snapshot.html;
        publishChangeSnapshot(snapshot, { immediate: true, sync: true });
      }
      clearDeferredUiFrame();
      deferredUiEditorRef.current = null;
      deferredUiNeedsChromeRefreshRef.current = false;
      if (shouldRefreshEditorChrome) {
        startTransition(() => {
          setUiTick((tick) => tick + 1);
        });
      }
      closeInternalReferencePicker();
      closeContactMentionPicker();
      closeTagPicker();
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      rememberCurrentTextSelection(nextEditor);
      scheduleDeferredEditorUi(nextEditor, { refreshChrome: true });
    },
    onTransaction: ({ transaction }) => {
      const sessions = rewriteSessionsRef.current;
      if (!transaction.docChanged || sessions.length === 0 || aiPreviewMutationRef.current) {
        return;
      }
      const nextSessions = sessions.map((session) => ({
        ...session,
        contextStale: true,
        anchorPos: transaction.mapping.map(session.anchorPos, -1),
        selectionSnapshot: {
          ...session.selectionSnapshot,
          from: transaction.mapping.map(session.selectionSnapshot.from, 1),
          to: transaction.mapping.map(session.selectionSnapshot.to, -1),
        },
        imageTarget: session.imageTarget
          ? { ...session.imageTarget, nodePos: transaction.mapping.map(session.imageTarget.nodePos, 1) }
          : undefined,
        modifyPreview: session.modifyPreview
          ? {
              ...session.modifyPreview,
              currentFrom: transaction.mapping.map(session.modifyPreview.currentFrom, 1),
              currentTo: transaction.mapping.map(session.modifyPreview.currentTo, -1),
            }
          : session.modifyPreview,
      }));
      rewriteSessionsRef.current = nextSessions;
      rewriteSessionRef.current = nextSessions[nextSessions.length - 1] ?? null;
      setRewriteSessions(nextSessions);
    },
    onUpdate: ({ editor: nextEditor }) => {
      if (aiPreviewMutationRef.current) {
        scheduleDeferredEditorUi(nextEditor, { refreshChrome: true });
        return;
      }
      if (rewriteSessionRef.current?.modifyPreview) {
        clearChangePublishTimer();
        aiPreviewMutationRef.current = true;
        let snapshot: RichEditorValue;
        try {
          snapshot = serializeCommittedEditor(nextEditor, rewriteSessionsRef.current);
        } finally {
          aiPreviewMutationRef.current = false;
        }
        lastResolvedHtmlRef.current = snapshot.html;
        publishChangeSnapshot(snapshot, { immediate: true, sync: true });
        scheduleDeferredEditorUi(nextEditor, { refreshChrome: true });
        if (persistStateRef.current !== "saving") {
          updatePersistState("dirty");
        }
        return;
      }
      if (taskShortcutTransformRef.current) {
        taskShortcutTransformRef.current = false;
      } else if (applyTaskListMarkdownShortcut(nextEditor)) {
        taskShortcutTransformRef.current = true;
        return;
      }
      if (onChange || onSnapshot) {
        scheduleChangeSnapshot(nextEditor);
      }
      scheduleDeferredEditorUi(nextEditor, { refreshChrome: true });
      if (persistStateRef.current !== "saving") {
        updatePersistState("dirty");
      }
    },
  });

  const closeEditorSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchMatches([]);
    setActiveSearchIndex(0);
    editor?.commands.focus(undefined, { scrollIntoView: false });
  }, [editor]);

  const selectSearchMatch = useCallback((index: number, options?: { focus?: boolean }) => {
    const nextEditor = editor;
    const matches = searchMatches;

    if (!nextEditor || matches.length === 0) {
      setActiveSearchIndex(0);
      return;
    }

    const nextIndex = clampNumber(index, 0, matches.length - 1);
    const match = matches[nextIndex];
    const shouldRestoreSearchFocus =
      document.activeElement === searchInputRef.current &&
      options?.focus !== true;
    setActiveSearchIndex(nextIndex);
    const selection = nextEditor.state.selection;
    if (selection.from !== match.from || selection.to !== match.to) {
      nextEditor.view.dispatch(
        nextEditor.state.tr
          .setSelection(TextSelection.create(nextEditor.state.doc, match.from, match.to))
          .scrollIntoView(),
      );
    }
    window.requestAnimationFrame(() => {
      if (nextEditor.isDestroyed) {
        return;
      }
      scrollSearchMatchIntoComfortView(nextEditor, match.from);
    });

    if (options?.focus) {
      nextEditor.commands.focus(undefined, { scrollIntoView: false });
    } else if (shouldRestoreSearchFocus) {
      searchInputRef.current?.focus();
      window.requestAnimationFrame(() => {
        if (nextEditor.isDestroyed) {
          return;
        }
        const activeElement = document.activeElement;
        if (activeElement instanceof Node && nextEditor.view.dom.contains(activeElement)) {
          searchInputRef.current?.focus();
        }
      });
    }
  }, [editor, searchMatches]);

  const goToNextSearchMatch = useCallback(() => {
    if (searchMatches.length === 0) {
      return;
    }

    selectSearchMatch((activeSearchIndex + 1) % searchMatches.length);
  }, [activeSearchIndex, searchMatches.length, selectSearchMatch]);

  const goToPreviousSearchMatch = useCallback(() => {
    if (searchMatches.length === 0) {
      return;
    }

    selectSearchMatch(
      activeSearchIndex === 0 ? searchMatches.length - 1 : activeSearchIndex - 1,
    );
  }, [activeSearchIndex, searchMatches.length, selectSearchMatch]);

  const replaceCurrentSearchMatch = useCallback(() => {
    if (!editor || effectiveReadOnly || searchMatches.length === 0) {
      return;
    }

    const match = searchMatches[Math.max(0, Math.min(activeSearchIndex, searchMatches.length - 1))];
    editor.chain().focus().insertContentAt({ from: match.from, to: match.to }, replaceQuery).run();
  }, [activeSearchIndex, editor, effectiveReadOnly, replaceQuery, searchMatches]);

  const replaceAllSearchMatches = useCallback(() => {
    if (!editor || effectiveReadOnly || searchMatches.length === 0) {
      return;
    }

    const tr = editor.state.tr;
    for (const match of [...searchMatches].sort((left, right) => right.from - left.from)) {
      tr.insertText(replaceQuery, match.from, match.to);
    }

    editor.view.dispatch(tr.scrollIntoView());
    editor.commands.focus(undefined, { scrollIntoView: false });
  }, [editor, effectiveReadOnly, replaceQuery, searchMatches]);

  useEffect(() => {
    if (!editor || !searchOpen) {
      setSearchMatches([]);
      setActiveSearchIndex(0);
      return;
    }

    const nextMatches = findEditorSearchMatches(editor, searchQuery);
    setSearchMatches((current) =>
      editorSearchMatchesEqual(current, nextMatches) ? current : nextMatches,
    );
    setActiveSearchIndex((current) => {
      if (nextMatches.length === 0) {
        return 0;
      }

      return Math.min(current, nextMatches.length - 1);
    });
  }, [editor, searchOpen, searchQuery, uiTick]);

  useEffect(() => {
    if (!editor || !searchOpen || searchMatches.length === 0) {
      return;
    }

    selectSearchMatch(activeSearchIndex);
  }, [activeSearchIndex, editor, searchMatches, searchOpen, selectSearchMatch]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const plugin = createEditorSearchPlugin({
      getSearchState: () => searchStateRef.current,
    });

    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(RICH_EDITOR_SEARCH_PLUGIN_KEY);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.view.dispatch(
      editor.state.tr.setMeta(RICH_EDITOR_SEARCH_PLUGIN_KEY, Date.now()),
    );
  }, [activeSearchIndex, editor, searchMatches, searchOpen]);

  const rewriteDisplayStatus: EditorSkillDisplayStatus = rewriteSession
    ? rewriteJob?.status === "cancelled"
      ? "failed"
      : rewriteJob?.status ?? "queued"
    : "queued";
  const rewriteWidgetState = useMemo<EditorSkillWidgetState | null>(() => {
    if (!rewriteSession) {
      return null;
    }

    const completedResult = rewriteJob?.status === "succeeded"
      ? readEditorSkillJobResult(rewriteJob)
      : null;
    return {
      skillName: rewriteSession.skill.name,
      anchorPos: rewriteSession.anchorPos,
      resultMode: rewriteSession.skill.resultMode,
      status: rewriteDisplayStatus,
      answer: rewriteSession.answer ?? null,
      answerHtml: rewriteSession.answer ? renderMarkdownToHtml(rewriteSession.answer) : null,
      modifyPreview: rewriteSession.modifyPreview ?? null,
      errorMessage: rewriteJob?.errorMessage ?? null,
      resolvedModel: completedResult?.resolvedModel ?? rewriteSession.resolvedModel ?? null,
      resolvedProfileName: completedResult?.resolvedProfileName ?? rewriteSession.resolvedProfileName ?? null,
      usedDefaultFallback: completedResult?.usedDefaultFallback ?? rewriteSession.usedDefaultFallback ?? false,
      contextStale: rewriteSession.contextStale ?? false,
      parseError: completedResult?.parseError ?? rewriteSession.parseError ?? null,
    };
  }, [rewriteDisplayStatus, rewriteJob, rewriteSession]);

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
    if (!editor || !rewriteWidgetState) {
      return;
    }

    editor.view.dispatch(
      editor.state.tr.setMeta(RICH_EDITOR_REWRITE_WIDGET_PLUGIN_KEY, Date.now()),
    );
  }, [editor, rewriteWidgetState]);

  const clearPersistTimer = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const clearBlurPersistTimer = useCallback(() => {
    if (blurPersistTimerRef.current) {
      window.clearTimeout(blurPersistTimerRef.current);
      blurPersistTimerRef.current = null;
    }
  }, []);

  const persistEditor = useCallback(
    async (reason: SaveReason, options?: { force?: boolean }) => {
      if (!editor || !onSave || readOnly) {
        return undefined;
      }

      clearChangePublishTimer();
      clearPersistTimer();
      clearBlurPersistTimer();

      aiPreviewMutationRef.current = true;
      let committedSnapshot: RichEditorValue;
      try {
        committedSnapshot = serializeCommittedEditor(editor, rewriteSessionsRef.current);
      } finally {
        aiPreviewMutationRef.current = false;
      }
      const snapshot = normalizeRichEditorValue(committedSnapshot);
      publishChangeSnapshot(snapshot, { immediate: true, sync: true });

      // Persistence must not rewrite the live document: even a visually empty
      // normalization transaction becomes a separate undo step after the
      // history grouping window has elapsed.
      if (snapshot.html === lastPersistedHtmlRef.current && !options?.force) {
        updatePersistState(snapshot.html === EMPTY_RICH_EDITOR_HTML ? "idle" : "saved");
        return undefined;
      }

      if (saveInFlightRef.current) {
        saveQueuedRef.current = true;
        return saveCycleRef.current?.promise;
      }

      if (!saveCycleRef.current) {
        let resolveCycle!: (value: unknown) => void;
        let rejectCycle!: (reason: unknown) => void;
        const promise = new Promise<unknown>((resolve, reject) => {
          resolveCycle = resolve;
          rejectCycle = reject;
        });
        void promise.catch(() => undefined);
        saveCycleRef.current = {
          promise,
          resolve: resolveCycle,
          reject: rejectCycle,
          error: null,
        };
      }
      saveInFlightRef.current = true;
      updatePersistState("saving");
      let saveSucceeded = false;

      try {
        const result = await onSave(snapshot);
        saveSucceeded = true;
        lastPersistedHtmlRef.current = snapshot.html;
        lastResolvedHtmlRef.current = snapshot.html;
        if (saveCycleRef.current) saveCycleRef.current.error = null;
        updatePersistState(snapshot.html === EMPTY_RICH_EDITOR_HTML ? "idle" : "saved");
        return result;
      } catch (error) {
        if (saveCycleRef.current) saveCycleRef.current.error = error;
        updatePersistState("error");
        throw error;
      } finally {
        saveInFlightRef.current = false;

        if (
          saveQueuedRef.current ||
          (saveSucceeded &&
            (reason === "blur" ||
              reason === "window-blur" ||
              reason === "visibility-hidden"))
        ) {
          saveQueuedRef.current = false;
          aiPreviewMutationRef.current = true;
          let latestSnapshot: RichEditorValue;
          try {
            latestSnapshot = serializeCommittedEditor(editor, rewriteSessionsRef.current);
          } finally {
            aiPreviewMutationRef.current = false;
          }

          if (latestSnapshot.html !== lastPersistedHtmlRef.current) {
            void persistEditor("queued").catch(() => {
              // The caller owns error presentation.
            });
            return;
          }
        }

        const cycle = saveCycleRef.current;
        saveCycleRef.current = null;
        if (cycle?.error) {
          cycle.reject(cycle.error);
        } else {
          cycle?.resolve(undefined);
        }
      }
    },
    [
      clearChangePublishTimer,
      clearBlurPersistTimer,
      clearPersistTimer,
      editor,
      onSave,
      publishChangeSnapshot,
      readOnly,
      updatePersistState,
    ],
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
    return () => {
      clearChangePublishTimer();
      clearDeferredUiFrame();
    };
  }, [
    clearChangePublishTimer,
    clearDeferredUiFrame,
  ]);

  const getCurrentValue = useCallback(() => {
    if (!editor) {
      return normalizeRichEditorValue({
        html: normalizeHtml(html ?? defaultHtml),
        text: "",
        markdown: "",
      });
    }

    return normalizeRichEditorValue(serializeEditor(editor));
  }, [defaultHtml, editor, html]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const nextHtml = normalizeHtml(html ?? defaultHtml);
    let currentHtml = normalizeHtml(editor.getHTML());

    if (aiPreviewMutationRef.current || internalEditorCommitInFlightRef.current) {
      return;
    }

    if (nextHtml === lastResolvedHtmlRef.current) {
      return;
    }

    if (rewriteSessionsRef.current.length > 0 || getEditorRewriteProtectedRange(editor)) {
      for (const session of [...rewriteSessionsRef.current].reverse()) {
        if (session.modifyPreview) {
          aiPreviewMutationRef.current = true;
          try {
            replaceEditorRangeWithSlice(
              editor,
              session.modifyPreview.currentFrom,
              session.modifyPreview.currentTo,
              session.modifyPreview.originalSlice,
            );
          } finally {
            aiPreviewMutationRef.current = false;
          }
        }
        const jobId = session.jobId ?? editorSkillJobIdsRef.current.get(session.targetKey);
        if (!jobId) abandonedEditorSkillTargetsRef.current.add(session.targetKey);
        if (jobId) void projectMindApi.aiJobCancel(jobId).catch(() => undefined);
        editorSkillJobIdsRef.current.delete(session.targetKey);
      }
      setEditorRewriteProtectedRange(editor, null);
      rewriteSessionRef.current = null;
      rewriteSessionsRef.current = [];
      setRewriteSessions([]);
      currentHtml = normalizeHtml(editor.getHTML());
    }

    if (nextHtml === currentHtml) {
      lastResolvedHtmlRef.current = nextHtml;
      return;
    }

    if (
      isFocusedRef.current &&
      (persistStateRef.current === "dirty" || persistStateRef.current === "saving")
    ) {
      return;
    }

    lastResolvedHtmlRef.current = nextHtml;
    lastPersistedHtmlRef.current = nextHtml;

    if (currentHtml !== nextHtml) {
      replaceEditorContentWithoutHistory(editor, nextHtml);
    }

    updatePersistState(nextHtml === EMPTY_RICH_EDITOR_HTML ? "idle" : "saved");
  }, [
    aiModifySessionActive,
    controlledHtmlReconcileGeneration,
    defaultHtml,
    editor,
    html,
    updatePersistState,
  ]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.setEditable(!effectiveReadOnly);
  }, [editor, effectiveReadOnly]);

  useEffect(() => {
    syncInternalReferencePicker(editor ?? null);
    syncContactMentionPicker(editor ?? null);
    syncTagPicker(editor ?? null);
  }, [editor, syncContactMentionPicker, syncInternalReferencePicker, syncTagPicker]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const editorDom = editor.view.dom;
    const handleFocusRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{
        position?: "start" | "end" | number | RichEditorAutoFocusPoint;
      }>;
      const position = customEvent.detail?.position;

      if (typeof position === "object" && position) {
        focusEditorForAutoFocus(editor, position);
        return;
      }

      editor.commands.focus(position ?? "end", { scrollIntoView: false });
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

  useEffect(() => {
    assetBusyRef.current = assetBusy;
  }, [assetBusy]);

  const persistForLifecycleChange = useCallback(
    (reason: "window-blur" | "visibility-hidden") => {
      if (!autosaveConfig.enabled || !onSave || readOnly) {
        return;
      }

      if (assetBusyRef.current !== null) {
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
      clearBlurPersistTimer();
    };
  }, [clearBlurPersistTimer, clearPersistTimer]);

  const handleBlur = useCallback((relatedTarget: EventTarget | null) => {
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

    clearBlurPersistTimer();
    blurPersistTimerRef.current = window.setTimeout(() => {
      blurPersistTimerRef.current = null;

      if (
        persistStateRef.current !== "dirty" &&
        persistStateRef.current !== "saving"
      ) {
        return;
      }

      void persistEditor("blur")
        .then((result) => {
          onBlurPersisted?.(result);
        })
        .catch(() => {
          // The activity page handles error feedback with a toast.
        });
    }, 48);
  }, [
    autosaveConfig.enabled,
    autosaveConfig.saveOnBlur,
    autosaveConfig.saveOnVisibilityChange,
    autosaveConfig.saveOnWindowBlur,
    clearBlurPersistTimer,
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

  const removeSelectionAndSave = useCallback(
    async ({ from, to }: { from: number; to: number }) => {
      if (!editor || !onSave || readOnly) {
        return undefined;
      }

      const docSize = editor.state.doc.content.size;
      const safeFrom = clampNumber(from, 0, docSize);
      const safeTo = clampNumber(to, safeFrom, docSize);

      if (safeFrom < safeTo) {
        const selection = TextSelection.create(editor.state.doc, safeFrom, safeTo);
        editor.view.dispatch(
          editor.state.tr.setSelection(selection).deleteSelection().scrollIntoView(),
        );
      }

      return persistEditor("manual", { force: true });
    },
    [editor, onSave, persistEditor, readOnly],
  );

  useEffect(() => {
    if (!controllerRef) {
      return;
    }

    controllerRef.current = {
      getValue: getCurrentValue,
      getCommittedValue: () => editor
        ? normalizeRichEditorValue(serializeCommittedEditor(editor, rewriteSessionsRef.current))
        : getCurrentValue(),
      getDocumentJson: () => editor?.getJSON() ?? { type: "doc", content: [] },
      getActiveAiProtectionCount: () => editor
        ? Object.keys(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(editor.state) ?? {}).length
        : 0,
      focus: (position) => {
        if (!editor) {
          return;
        }

        if (typeof position === "object" && position) {
          focusEditorForAutoFocus(editor, position);
          return;
        }

        editor.commands.focus(position ?? "end", { scrollIntoView: false });
      },
      save: (options) => handleManualSave(options),
    };

    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, editor, getCurrentValue, handleManualSave]);

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
          isStarred: asset.isStarred,
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
      const isStarred = attachment.dataset.isStarred === "true";
      const asset: RichEditorAsset = {
        kind: "file",
        title,
        href,
        path,
        mimeType,
        documentId,
        meta,
        isStarred,
      };

      const openPromise = onOpenAsset
        ? Promise.resolve(onOpenAsset(asset))
        : openAttachmentAsset(asset);

      void openPromise.catch(() => {
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
      const displayedImageSrc = imageElement?.getAttribute("src")?.trim() || undefined;

      setAnnotationDialog({
        nodePos: imageTarget.nodePos,
        title: imageTarget.attrs.title?.trim() || imageTarget.attrs.alt?.trim() || "图片浏览",
        imageSrc,
        fallbackImageSrc:
          displayedImageSrc && displayedImageSrc !== imageSrc ? displayedImageSrc : undefined,
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

  const updateTableToolbarPosition = useCallback(() => {
    if (!editorHasTableSelection || !editor) {
      setTableToolbarPosition(null);
      return;
    }

    const frame = frameRef.current;
    const toolbar = tableToolbarRef.current;
    const tableElement = resolveActiveTableElement(editor);

    if (!frame || !toolbar || !tableElement) {
      setTableToolbarPosition(null);
      return;
    }

    const frameRect = frame.getBoundingClientRect();
    const tableRect = tableElement.getBoundingClientRect();
    const toolbarWidth = toolbar.offsetWidth;
    const toolbarHeight = toolbar.offsetHeight;
    const margin = 8;

    const tableLeft = tableRect.left - frameRect.left + frame.scrollLeft;
    const tableTop = tableRect.top - frameRect.top + frame.scrollTop;
    const minLeft = frame.scrollLeft + margin;
    const maxLeft = Math.max(minLeft, frame.scrollLeft + frame.clientWidth - toolbarWidth - margin);
    const nextLeft = clampNumber(tableLeft, minLeft, maxLeft);
    const nextTop = Math.max(frame.scrollTop + margin, tableTop - toolbarHeight - margin);

    setTableToolbarPosition((current) => {
      if (current && current.left === nextLeft && current.top === nextTop) {
        return current;
      }

      return { left: nextLeft, top: nextTop };
    });
  }, [editor, editorHasTableSelection]);

  useLayoutEffect(() => {
    if (tableToolbarGroups.length === 0) {
      setTableToolbarPosition(null);
      return;
    }

    updateTableToolbarPosition();
  }, [tableToolbarGroups.length, uiTick, updateTableToolbarPosition]);

  useEffect(() => {
    if (tableToolbarGroups.length === 0) {
      return;
    }

    const frame = frameRef.current;

    if (!frame) {
      return;
    }

    const syncPosition = () => {
      window.requestAnimationFrame(() => {
        updateTableToolbarPosition();
      });
    };

    frame.addEventListener("scroll", syncPosition, { passive: true });
    window.addEventListener("resize", syncPosition);

    return () => {
      frame.removeEventListener("scroll", syncPosition);
      window.removeEventListener("resize", syncPosition);
    };
  }, [tableToolbarGroups.length, updateTableToolbarPosition]);

  const activeCodeBlockInfo = useMemo(() => {
    if (!editor || effectiveReadOnly || !editor.isEditable) {
      return null;
    }

    return getActiveCodeBlockInfo(editor);
  }, [editor, effectiveReadOnly, uiTick]);

  const updateCodeToolbarPosition = useCallback(() => {
    if (!editor || !activeCodeBlockInfo) {
      setCodeToolbarPosition(null);
      return;
    }

    const frame = frameRef.current;
    const toolbar = codeToolbarRef.current;
    const codeElement = editor.view.nodeDOM(activeCodeBlockInfo.pos);

    if (!frame || !toolbar || !(codeElement instanceof HTMLElement)) {
      setCodeToolbarPosition(null);
      return;
    }

    const codeRect = codeElement.getBoundingClientRect();
    const margin = 8;
    const toolbarWidth = toolbar.offsetWidth || 220;
    const minLeft = margin;
    const maxLeft = Math.max(minLeft, window.innerWidth - toolbarWidth - margin);
    const nextLeft = clampNumber(
      codeRect.left + margin,
      minLeft,
      maxLeft,
    );
    const nextTop = Math.max(margin, codeRect.top + margin);

    setCodeToolbarPosition((current) => {
      if (current && current.left === nextLeft && current.top === nextTop) {
        return current;
      }

      return { left: nextLeft, top: nextTop };
    });
  }, [activeCodeBlockInfo, editor]);

  useLayoutEffect(() => {
    if (!activeCodeBlockInfo) {
      setCodeToolbarPosition(null);
      setCodeLanguagePanelOpen(false);
      setCodeLanguageContextMenuOpen(false);
      return;
    }

    updateCodeToolbarPosition();
  }, [activeCodeBlockInfo, uiTick, updateCodeToolbarPosition]);

  useEffect(() => {
    if (!activeCodeBlockInfo) {
      return;
    }

    const frame = frameRef.current;

    if (!frame) {
      return;
    }

    let syncFrame = 0;
    const closeCodeLanguageMenu = () => {
      setCodeLanguagePanelOpen(false);
      setCodeLanguageContextMenuOpen(false);
      setCodeLanguageQuery("");
    };
    const syncPosition = () => {
      if (syncFrame) {
        return;
      }

      syncFrame = window.requestAnimationFrame(() => {
        syncFrame = 0;
        updateCodeToolbarPosition();
      });
    };
    const closeOnScroll = () => {
      closeCodeLanguageMenu();
    };
    const documentScrollOptions: AddEventListenerOptions = { passive: true, capture: true };

    frame.addEventListener("scroll", closeOnScroll, { passive: true });
    window.addEventListener("scroll", closeOnScroll, documentScrollOptions);
    window.addEventListener("wheel", closeOnScroll, documentScrollOptions);
    window.addEventListener("resize", syncPosition);

    return () => {
      window.cancelAnimationFrame(syncFrame);
      frame.removeEventListener("scroll", closeOnScroll);
      window.removeEventListener("scroll", closeOnScroll, documentScrollOptions);
      window.removeEventListener("wheel", closeOnScroll, documentScrollOptions);
      window.removeEventListener("resize", syncPosition);
    };
  }, [
    activeCodeBlockInfo,
    updateCodeToolbarPosition,
  ]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const frame = frameRef.current;

    if (!frame) {
      return;
    }

    const handleCodeLanguageOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: "select" | "document"; pos?: number }>).detail;
      const pos = Number(detail?.pos);

      if (!Number.isFinite(pos)) {
        return;
      }

      try {
        editor.view.dispatch(
          editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 1)),
        );
      } catch {
        editor.commands.focus();
      }

      setCodeLanguageQuery("");
      setCodeLanguagePanelOpen(detail?.mode !== "document");
      setCodeLanguageContextMenuOpen(detail?.mode === "document");
      editor.commands.focus(undefined, { scrollIntoView: false });
      window.requestAnimationFrame(() => updateCodeToolbarPosition());
    };

    frame.addEventListener(RICH_EDITOR_CODE_LANGUAGE_OPEN_EVENT, handleCodeLanguageOpen);
    return () => {
      frame.removeEventListener(RICH_EDITOR_CODE_LANGUAGE_OPEN_EVENT, handleCodeLanguageOpen);
    };
  }, [editor, updateCodeToolbarPosition]);

  const applyCodeLanguage = useCallback(
    (language: string | null) => {
      if (!editor || !activeCodeBlockInfo) {
        return;
      }

      const normalized = normalizeCodeLanguage(language);
      applyCodeBlockLanguage(editor, activeCodeBlockInfo.pos, normalized);
      setCodeLanguageQuery("");
      setCodeLanguagePanelOpen(false);
      setCodeLanguageContextMenuOpen(false);
      editor.commands.focus();
    },
    [activeCodeBlockInfo, editor],
  );

  const applyCurrentCodeLanguageToDocument = useCallback(() => {
    if (!editor || !activeCodeBlockInfo || !activeCodeBlockInfo.language) {
      return;
    }

    setCodeLanguagePanelOpen(false);
    setCodeLanguageContextMenuOpen(false);
    setCodeLanguageQuery("");
    applyPlainTextCodeBlocksLanguage(editor, activeCodeBlockInfo.language);
    editor.commands.focus();
  }, [activeCodeBlockInfo, editor]);

  const rollbackRewritePreview = useCallback((session: EditorSkillSessionState | null) => {
    if (!editor || !session?.modifyPreview) {
      return;
    }
    aiPreviewMutationRef.current = true;
    try {
      replaceEditorRangeWithSlice(
        editor,
        session.modifyPreview.currentFrom,
        session.modifyPreview.currentTo,
        session.modifyPreview.originalSlice,
      );
    } finally {
      aiPreviewMutationRef.current = false;
    }
  }, [editor]);

  const closeRewriteSession = useCallback(() => {
    const session = rewriteSessionRef.current;
    rollbackRewritePreview(session);
    const jobId = session?.jobId ?? (session ? editorSkillJobIdsRef.current.get(session.targetKey) : null);
    if (session && !jobId) abandonedEditorSkillTargetsRef.current.add(session.targetKey);
    if (jobId) {
      const currentJob = useAiJobStore.getState().jobsById[jobId];
      editorSkillJobIdsRef.current.delete(session?.targetKey ?? "");
      void projectMindApi.aiJobCancel(jobId).then((snapshot) => {
        if (snapshot) useAiJobStore.getState().upsertJob(snapshot);
      }).catch(() => undefined);
      if (currentJob?.status === "queued" || currentJob?.status === "running") {
        pushToast({
          tone: "info",
          title: "已取消 AI 请求",
          detail: "请求已尽力取消；外部模型若已开始处理，仍可能产生费用。",
        });
      }
    }
    if (editor) {
      setEditorRewriteProtectedRange(editor, null, session?.targetKey);
    }
    rewriteSessionRef.current = null;
    setRewriteSession(null);
    if (editor) releaseEditorViewportPreservation(editor, 1_000);
  }, [editor, pushToast, rollbackRewritePreview]);

  const closeAiMenu = useCallback(() => {
    setAiMenu(null);
  }, []);

  const activateEditorSkillSession = useCallback((targetKey: string) => {
    setRewriteSessions((current) => {
      const session = current.find((item) => item.targetKey === targetKey);
      if (!session || current[current.length - 1]?.targetKey === targetKey) return current;
      return [...current.filter((item) => item.targetKey !== targetKey), session];
    });
  }, []);

  const closeEditorSkillSession = useCallback((targetKey: string) => {
    const session = rewriteSessionsRef.current.find((item) => item.targetKey === targetKey);
    if (!session) return;
    rollbackRewritePreview(session);
    const jobId = session.jobId ?? editorSkillJobIdsRef.current.get(targetKey);
    if (!jobId) abandonedEditorSkillTargetsRef.current.add(targetKey);
    if (jobId) void projectMindApi.aiJobCancel(jobId).catch(() => undefined);
    editorSkillJobIdsRef.current.delete(targetKey);
    if (editor) setEditorRewriteProtectedRange(editor, null, targetKey);
    setRewriteSessions((current) => current.filter((item) => item.targetKey !== targetKey));
    if (editor) releaseEditorViewportPreservation(editor, 1_000);
  }, [editor, rollbackRewritePreview]);

  useEffect(() => () => {
    const sessions = rewriteSessionsRef.current;
    for (const session of [...sessions].reverse()) {
      rollbackRewritePreview(session);
      const jobId = session.jobId ?? editorSkillJobIdsRef.current.get(session.targetKey);
      if (!jobId) abandonedEditorSkillTargetsRef.current.add(session.targetKey);
      if (jobId) {
        void projectMindApi.aiJobCancel(jobId).catch(() => undefined);
      }
      editorSkillJobIdsRef.current.delete(session.targetKey);
    }
    if (editor) setEditorRewriteProtectedRange(editor, null);
    if (editor) releaseEditorViewportPreservation(editor);
    rewriteSessionRef.current = null;
    rewriteSessionsRef.current = [];
  }, [editor, rollbackRewritePreview]);

  useEffect(() => {
    const contextKey = JSON.stringify(aiRewriteContext ?? null);
    const sessions = rewriteSessionsRef.current;
    if (sessions.length === 0 || sessions.every((session) => session.contextKey === contextKey)) {
      return;
    }
    for (const session of [...sessions].reverse()) {
      rollbackRewritePreview(session);
      const jobId = session.jobId ?? editorSkillJobIdsRef.current.get(session.targetKey);
      if (!jobId) abandonedEditorSkillTargetsRef.current.add(session.targetKey);
      if (jobId) void projectMindApi.aiJobCancel(jobId).catch(() => undefined);
      editorSkillJobIdsRef.current.delete(session.targetKey);
    }
    if (editor) setEditorRewriteProtectedRange(editor, null);
    if (editor) releaseEditorViewportPreservation(editor, 1_000);
    rewriteSessionRef.current = null;
    rewriteSessionsRef.current = [];
    setRewriteSessions([]);
  }, [aiRewriteContext, editor, rollbackRewritePreview]);

  const startEditorSkill = useCallback(
    async (options: {
      skillId?: string | null;
      skillName: string;
      prompt: string;
      resultMode: AiEditorSkillResultMode;
      selectionSnapshot?: EditorAiSelectionSnapshot;
      replaceExistingSession?: boolean;
      targetType?: "text" | "image";
      imageTarget?: ImageContextMenuTarget;
    }) => {
      if (!editor) {
        return;
      }

      const targetType = options.targetType ?? "text";

      const unavailableReason = targetType === "image"
        ? (aiSettings?.aiSecretsUnlocked === false
            ? "需先解锁 AI 配置"
            : !imageInterpretationReady
              ? "需先配置支持图片的 AI 模型"
              : null)
        : rewriteUnavailableReason;
      if (unavailableReason) {
        onOpenAiSettings?.();
        pushToast({
          tone: "error",
          title: "AI 编辑暂不可用",
          detail:
            unavailableReason === "需先解锁 AI 配置"
              ? "请先解锁 AI 配置，再运行编辑 AI。"
              : targetType === "image"
                ? "请先在 AI 设置里配置支持文字与图片的图片默认模型。"
                : "请先在 AI 设置里完成编辑 AI 能力绑定。",
        });
        return;
      }

      let selectionSnapshot = options.selectionSnapshot;
      if (targetType === "image" && !selectionSnapshot) {
        const imageTarget = options.imageTarget;
        const imageNode = imageTarget ? editor.state.doc.nodeAt(imageTarget.nodePos) : null;
        if (!imageTarget || !imageNode || imageNode.type.name !== "image") {
          pushToast({ tone: "error", title: "图片已发生变化", detail: "请重新右键选择图片。" });
          return;
        }
        selectionSnapshot = {
          from: imageTarget.nodePos,
          to: imageTarget.nodePos + imageNode.nodeSize,
          text: "[single image target]",
          markdown: "[single image target]",
          placeholders: [],
          originalSlice: editor.state.doc.slice(imageTarget.nodePos, imageTarget.nodePos + imageNode.nodeSize),
        };
      }
      if (!selectionSnapshot) {
        restoreStoredTextSelection(editor);
        const selection = editor.state.selection;
        if (!(selection instanceof TextSelection) || selection.empty) {
          return;
        }
        const rewriteSelection = buildEditorRewriteSelection(editor);
        if (!rewriteSelection?.selectedText.trim() || !rewriteSelection.expandedMarkdown.trim()) {
          return;
        }
        selectionSnapshot = {
          from: rewriteSelection.from,
          to: rewriteSelection.to,
          text: rewriteSelection.selectedText.trim(),
          markdown: rewriteSelection.expandedMarkdown.trim(),
          placeholders: rewriteSelection.placeholders,
          originalSlice: editor.state.doc.slice(rewriteSelection.from, rewriteSelection.to),
        };
      }

      if (!selectionSnapshot.text.trim()) {
        return;
      }

      const overlappingSession = rewriteSessionsRef.current.find((session) =>
        selectionSnapshot.from < session.selectionSnapshot.to
        && selectionSnapshot.to > session.selectionSnapshot.from
        && (!options.replaceExistingSession || session.targetKey !== rewriteSessionRef.current?.targetKey)
      );
      if (overlappingSession) {
        pushToast({
          tone: "info",
          title: "该目标正在由 AI 处理",
          detail: "同一图片或重叠文字范围不能重复运行；请选择不重叠的目标。",
        });
        return;
      }

      const targetKey = aiEditorSkillJobTargetKey(
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );

      const nextSession: EditorSkillSessionState = {
        targetKey,
        skill: {
          id: options.skillId ?? null,
          name: options.skillName,
          prompt: options.prompt,
          resultMode: options.resultMode,
        },
        selectionSnapshot,
        anchorPos: selectionSnapshot.to,
        modifyPreview: null,
        answer: null,
        targetType,
        imageTarget: options.imageTarget,
        jobId: null,
        contextKey: JSON.stringify(aiRewriteContext ?? null),
        contextStale: false,
      };
      preserveEditorViewport(editor);
      if (options.replaceExistingSession) setRewriteSession(nextSession);
      else setRewriteSessions((current) => [...current, nextSession]);
      if (options.resultMode !== "answer" || targetType === "image") {
        setEditorRewriteProtectedRange(editor, {
          from: selectionSnapshot.from,
          to: selectionSnapshot.to,
        }, targetKey);
      }
      setAiMenu(null);
      setContextMenu(null);

      try {
        await ensureAiJobSync();
        const imagePath = targetType === "image"
          ? resolveImageTargetPath(options.imageTarget?.attrs)
          : null;
        if (targetType === "image" && !imagePath) {
          throw new Error("图片没有可读取的本地原图路径。");
        }
        const annotationState = options.imageTarget?.attrs.annotationState ?? null;
        const signature = imagePath
          ? await projectMindApi.aiImageTargetSignature({ path: imagePath, annotationState })
          : null;
        const nearby = targetType === "image" && options.imageTarget
          ? buildImageEditorContext(editor, options.imageTarget.nodePos)
          : null;
        const queuedJob = await projectMindApi.aiJobEnqueue(
          editorSkillJobInput(targetKey, {
            skillId: options.skillId ?? null,
            skillName: options.skillName,
            prompt: options.prompt,
            resultMode: options.resultMode,
            selectedText: selectionSnapshot.markdown,
            expandedMarkdown: selectionSnapshot.markdown,
            placeholderTokens: selectionSnapshot.placeholders.map((placeholder) => placeholder.token),
            documentContext: null,
            context: aiRewriteContext,
            targetType,
            imageTarget: imagePath && signature
              ? {
                  path: imagePath,
                  mimeType: resolveImageTargetMimeType(options.imageTarget?.attrs, imagePath),
                  signature,
                  annotationState,
                  beforeMarkdown: nearby?.beforeMarkdown ?? null,
                  afterMarkdown: nearby?.afterMarkdown ?? null,
                }
              : null,
          }),
        );
        editorSkillJobIdsRef.current.set(targetKey, queuedJob.id);
        useAiJobStore.getState().upsertJob(queuedJob);
        if (abandonedEditorSkillTargetsRef.current.delete(targetKey)) {
          const cancelled = await projectMindApi.aiJobCancel(queuedJob.id).catch(() => null);
          editorSkillJobIdsRef.current.delete(targetKey);
          if (cancelled) useAiJobStore.getState().upsertJob(cancelled);
          return;
        }
        updateRewriteSessionByTarget(targetKey, (current) => ({
          ...current,
          jobId: queuedJob.id,
        }));
      } catch (error) {
        editorSkillJobIdsRef.current.delete(targetKey);
        rollbackRewritePreview(nextSession);
        setEditorRewriteProtectedRange(editor, null, targetKey);
        updateRewriteSessionByTarget(targetKey, () => null);
        releaseEditorViewportPreservation(editor, 1_000);
        pushToast({
          tone: "error",
          title: "AI 改写失败",
          detail: error instanceof Error ? error.message : "启动改写任务失败",
        });
      }
    },
    [
      aiRewriteContext,
      aiSettings?.aiSecretsUnlocked,
      editor,
      imageInterpretationReady,
      onOpenAiSettings,
      pushToast,
      restoreStoredTextSelection,
      rollbackRewritePreview,
      updateRewriteSessionByTarget,
      rewriteUnavailableReason,
    ],
  );

  const runEditorRewriteAction = useCallback(
    (skill: AiSettingsSnapshot["editorSkills"][number]) => {
      void startEditorSkill({
        skillId: skill.id,
        skillName: skill.name,
        prompt: skill.prompt,
        resultMode: skill.resultMode,
      });
    },
    [startEditorSkill],
  );

  const runEditorRewritePrompt = useCallback(
    (prompt: string) => {
      void startEditorSkill({
        skillId: null,
        skillName: "AI 编辑",
        prompt,
        resultMode: "auto",
      });
    },
    [startEditorSkill],
  );

  const runImageInterpretationAction = useCallback(
    (skill: AiSettingsSnapshot["editorSkills"][number], imageTarget: ImageContextMenuTarget) => {
      void startEditorSkill({
        skillId: skill.id,
        skillName: skill.name,
        prompt: skill.prompt,
        resultMode: skill.resultMode,
        targetType: "image",
        imageTarget,
      });
    },
    [startEditorSkill],
  );

  const runAiMenuPrompt = useCallback((prompt: string) => {
    if (aiMenu?.targetType === "image" && aiMenu.imageTarget) {
      void startEditorSkill({
        skillId: null,
        skillName: "AI 解读图片",
        prompt,
        resultMode: "auto",
        targetType: "image",
        imageTarget: aiMenu.imageTarget,
      });
      return;
    }
    runEditorRewritePrompt(prompt);
  }, [aiMenu, runEditorRewritePrompt, startEditorSkill]);

  const replaceAiPreviewMarkdown = useCallback(
    (markdown: string, showing: "original" | "modified") => {
      const session = rewriteSessionRef.current;
      if (!editor || !session?.modifyPreview) {
        return;
      }

      const preview = session.modifyPreview;
      if (preview.showing === showing && (showing === "original" || preview.modifiedMarkdown === markdown)) {
        return;
      }

      try {
        const protectedRange = getEditorRewriteProtectedRange(editor, session.targetKey);
        if (!protectedRange) {
          throw new Error("AI 修改范围已失效，请重新选择文本后再试。");
        }
        aiPreviewMutationRef.current = true;
        let nextTo = preview.currentTo;
        let nextFrom = preview.currentFrom;
        try {
          const slice =
            showing === "original"
              ? preview.originalSlice
              : buildEditorRewriteSlice(editor, markdown, preview.placeholders);
          nextTo = replaceEditorRangeWithSlice(
            editor,
            preview.currentFrom,
            preview.currentTo,
            slice,
          );
          nextFrom = preview.currentFrom;
          setEditorRewriteProtectedRange(editor, {
            from: session.targetType === "image" ? session.selectionSnapshot.from : nextFrom,
            to: nextTo,
          }, session.targetKey);
        } finally {
          aiPreviewMutationRef.current = false;
        }

        const nextPreview: EditorAiModifyPreview = {
          ...preview,
          modifiedMarkdown: showing === "modified" ? markdown : preview.modifiedMarkdown,
          currentFrom: nextFrom,
          currentTo: nextTo,
          showing,
        };
        const nextSession: EditorSkillSessionState = {
          ...session,
          anchorPos: nextTo,
          modifyPreview: nextPreview,
        };
        rewriteSessionRef.current = nextSession;
        flushSync(() => {
          setRewriteSession((current) =>
            current?.targetKey === session.targetKey
              ? {
                  ...current,
                  anchorPos: nextTo,
                  modifyPreview: {
                    ...(current.modifyPreview ?? preview),
                    modifiedMarkdown:
                      showing === "modified" ? markdown : (current.modifyPreview ?? preview).modifiedMarkdown,
                    currentFrom: nextFrom,
                    currentTo: nextTo,
                    showing,
                  },
                }
              : current,
          );
        });
      } catch (error) {
        setEditorRewriteProtectedRange(editor, null, session.targetKey);
        rewriteSessionRef.current = null;
        setRewriteSession(null);
        releaseEditorViewportPreservation(editor, 1_000);
        pushToast({
          tone: "error",
          title: "应用 AI 结果失败",
          detail: error instanceof Error ? error.message : "AI 结果无法写回编辑器",
        });
      }
    },
    [editor, pushToast],
  );

  const publishAiEditorSnapshot = useCallback(() => {
    if (!editor) {
      return;
    }
    const snapshot = serializeEditor(editor);
    lastResolvedHtmlRef.current = snapshot.html;
    publishChangeSnapshot(snapshot, { immediate: true, sync: true });
    updatePersistState("dirty");
  }, [editor, publishChangeSnapshot, updatePersistState]);

  const acceptModifyPreview = useCallback(() => {
    const session = rewriteSessionRef.current;
    if (!editor || !session?.modifyPreview) return;
    const preview = session.modifyPreview;
    rollbackRewritePreview(session);
    setEditorRewriteProtectedRange(editor, null, session.targetKey);
    const modifiedSlice = buildEditorRewriteSlice(editor, preview.modifiedMarkdown, preview.placeholders);
    const originalTo = preview.currentFrom + preview.originalSlice.size;
    const resolvedSession = session.answer
      ? { ...session, modifyPreview: null, modificationResolved: true }
      : null;
    rewriteSessionRef.current = resolvedSession;
    const transaction = markEditorRewriteTransaction(
      editor.state.tr.replaceRange(preview.currentFrom, originalTo, modifiedSlice),
    );
    aiPreviewMutationRef.current = true;
    try {
      editor.view.dispatch(transaction);
    } finally {
      aiPreviewMutationRef.current = false;
    }
    publishAiEditorSnapshot();
    releaseEditorViewportPreservation(editor, 1_000);
    setRewriteSession((current) =>
      current?.answer
        ? {
            ...current,
            modifyPreview: null,
            modificationResolved: true,
          }
        : null,
    );
    synchronizeResolvedRewriteSession(session.targetKey, resolvedSession);
  }, [editor, publishAiEditorSnapshot, rollbackRewritePreview]);

  const rejectModifyPreview = useCallback(() => {
    if (rewriteJob?.status === "queued" || rewriteJob?.status === "running") {
      closeRewriteSession();
      return;
    }
    if (!rewriteSession?.modifyPreview) {
      if (editor) {
        setEditorRewriteProtectedRange(editor, null, rewriteSession?.targetKey);
        releaseEditorViewportPreservation(editor, 1_000);
      }
      setRewriteSession(null);
      return;
    }
    replaceAiPreviewMarkdown(rewriteSession.modifyPreview.originalMarkdown, "original");
    publishAiEditorSnapshot();
    if (editor) {
      setEditorRewriteProtectedRange(editor, null, rewriteSession.targetKey);
      releaseEditorViewportPreservation(editor, 1_000);
    }
    setRewriteSession((current) =>
      current?.answer
        ? {
            ...current,
            modifyPreview: null,
            modificationResolved: true,
          }
        : null,
    );
  }, [closeRewriteSession, editor, publishAiEditorSnapshot, replaceAiPreviewMarkdown, rewriteJob?.status, rewriteSession]);

  const copyAiAnswer = useCallback(() => {
    const answer = rewriteSession?.answer?.trim();
    if (!answer) {
      return;
    }
    const clipboardWrite = navigator.clipboard?.writeText?.(answer);
    void (clipboardWrite ?? runFallbackClipboardWrite(answer)).catch(() => {
      void runFallbackClipboardWrite(answer);
    });
  }, [rewriteSession?.answer]);

  const insertAiAnswer = useCallback(() => {
    if (!editor || !rewriteSession?.answer || rewriteSession.parseError) {
      return;
    }

    const protectedRange = getEditorRewriteProtectedRange(editor, rewriteSession.targetKey);
    const insertPosition = getInsertPositionAfterSelectedBlock(
      editor,
      protectedRange?.to ?? rewriteSession.anchorPos,
    );
    const previousSessions = rewriteSessionsRef.current;
    const nextSessions = previousSessions.filter(
      (session) => session.targetKey !== rewriteSession.targetKey,
    );
    internalEditorCommitInFlightRef.current = true;
    setEditorRewriteProtectedRange(editor, null, rewriteSession.targetKey);
    rewriteSessionsRef.current = nextSessions;
    rewriteSessionRef.current = nextSessions[nextSessions.length - 1] ?? null;
    setRewriteSessions(nextSessions);
    aiPreviewMutationRef.current = true;
    let inserted = false;
    try {
      inserted = insertMarkdownAtPosition(
        editor,
        insertPosition,
        wrapMarkdownAsBlockquote(rewriteSession.answer),
      );
    } finally {
      aiPreviewMutationRef.current = false;
    }
    if (!inserted) {
      internalEditorCommitInFlightRef.current = false;
      rewriteSessionsRef.current = previousSessions;
      rewriteSessionRef.current = previousSessions[previousSessions.length - 1] ?? null;
      setRewriteSessions(previousSessions);
      if (protectedRange) {
        setEditorRewriteProtectedRange(editor, protectedRange, rewriteSession.targetKey);
      }
      pushToast({
        tone: "error",
        title: "插入 AI 回答失败",
        detail: "目标图片位置已失效，请保留回答并重新选择图片后再试。",
      });
      return;
    }
    editorSkillJobIdsRef.current.delete(rewriteSession.targetKey);
    publishAiEditorSnapshot();
    releaseEditorViewportPreservation(editor, 1_000);
    window.requestAnimationFrame(() => {
      internalEditorCommitInFlightRef.current = false;
      setControlledHtmlReconcileGeneration((current) => current + 1);
    });
  }, [editor, publishAiEditorSnapshot, pushToast, rewriteSession]);

  const retryAiSession = useCallback(() => {
    if (!rewriteSession) {
      return;
    }
    rollbackRewritePreview(rewriteSession);
    const protectedRange = editor
      ? getEditorRewriteProtectedRange(editor, rewriteSession.targetKey)
      : null;
    const jobId = rewriteSession.jobId ?? editorSkillJobIdsRef.current.get(rewriteSession.targetKey);
    if (jobId) void projectMindApi.aiJobCancel(jobId).catch(() => undefined);
    if (editor) setEditorRewriteProtectedRange(editor, null, rewriteSession.targetKey);
    editorSkillJobIdsRef.current.delete(rewriteSession.targetKey);
    void startEditorSkill({
      skillId: rewriteSession.skill.id ?? null,
      skillName: rewriteSession.skill.name,
      prompt: rewriteSession.skill.prompt,
      resultMode: rewriteSession.skill.resultMode,
      replaceExistingSession: true,
      targetType: rewriteSession.targetType,
      imageTarget: rewriteSession.imageTarget
        ? {
            ...rewriteSession.imageTarget,
            nodePos: protectedRange?.from ?? rewriteSession.imageTarget.nodePos,
          }
        : undefined,
      selectionSnapshot: protectedRange
        ? {
            ...rewriteSession.selectionSnapshot,
            from: protectedRange.from,
            to: protectedRange.to,
          }
        : rewriteSession.selectionSnapshot,
    });
  }, [editor, rewriteSession, rollbackRewritePreview, startEditorSkill]);

  useEffect(() => {
    if (!editor || !rewriteSession) {
      return;
    }
    if (rewriteJob?.status !== "running" && rewriteJob?.status !== "succeeded") {
      return;
    }
    if (rewriteSession.modificationResolved) {
      return;
    }

    try {
      const isAutomatic = rewriteSession.skill.resultMode === "auto";
      if (isAutomatic && rewriteJob.status !== "succeeded") {
        return;
      }

      const result =
        rewriteJob.status === "succeeded"
          ? readEditorSkillJobResult(rewriteJob)
          : null;
      const automaticAnswer = isAutomatic
        ? result?.answerMarkdown?.trim() || null
        : null;
      if (result?.parseError) {
        rollbackRewritePreview(rewriteSession);
        setEditorRewriteProtectedRange(editor, null, rewriteSession.targetKey);
        setRewriteSession((current) => current?.targetKey !== rewriteSession.targetKey ? current : {
          ...current,
          answer: result.answerMarkdown?.trim() || result.content,
          modifyPreview: null,
          modificationResolved: true,
          parseError: result.parseError,
        });
        return;
      }
      const visibleAutomaticAnswer = automaticAnswer && isEditorRewriteMarkdownPreviewReady(
        automaticAnswer,
        buildEditorRewriteSlice(editor, automaticAnswer, []),
      )
        ? automaticAnswer
        : null;
      const content = isAutomatic
        ? result?.replacementMarkdown?.trim() || ""
        : result?.content.trim() || rewriteJob.streamText?.trim() || "";

      if (isAutomatic && !content) {
        if (!automaticAnswer) {
          throw new Error("AI 未返回原文修改或回答内容。");
        }
        if (!visibleAutomaticAnswer) {
          throw new Error("AI 返回内容没有可显示的正文。");
        }
        const protectedRange = getEditorRewriteProtectedRange(editor, rewriteSession.targetKey);
        setEditorRewriteProtectedRange(editor, null, rewriteSession.targetKey);
        if (rewriteSession.answer === visibleAutomaticAnswer && !rewriteSession.modifyPreview) {
          return;
        }
        setRewriteSession((current) => current?.targetKey !== rewriteSession.targetKey ? current : {
          ...current,
          anchorPos: protectedRange?.to ?? current.anchorPos,
          answer: visibleAutomaticAnswer,
          modifyPreview: null,
        });
        return;
      }
      if (!content) {
        return;
      }
      if (rewriteSession.skill.resultMode === "answer") {
        const answerSlice = buildEditorRewriteSlice(editor, content, []);
        if (!isEditorRewriteMarkdownPreviewReady(content, answerSlice)) {
          if (rewriteJob.status === "running") {
            return;
          }
          throw new Error("AI 返回内容没有可显示的正文。");
        }
        if (rewriteSession.answer === content) {
          return;
        }
        setRewriteSession((current) => current?.targetKey !== rewriteSession.targetKey ? current : {
          ...current,
          answer: content,
        });
        return;
      }

      if (
        (rewriteSession.skill.resultMode === "modify" || isAutomatic) &&
        rewriteSession.selectionSnapshot.placeholders.length > 0
      ) {
        const hasRequiredPlaceholders = hasAllPlaceholderTokens(
          content,
          rewriteSession.selectionSnapshot.placeholders,
        );
        if (!hasRequiredPlaceholders && rewriteJob.status === "running") {
          return;
        }
        if (!hasRequiredPlaceholders) {
          throw new Error("AI 返回内容缺少需要保留的图片、表格或附件占位符。");
        }
      }

      if (
        rewriteSession.modifyPreview?.modifiedMarkdown === content &&
        rewriteSession.answer === visibleAutomaticAnswer
      ) {
        return;
      }
      const snapshot = rewriteSession.selectionSnapshot;
      const protectedRange = getEditorRewriteProtectedRange(editor, rewriteSession.targetKey);
      if (!protectedRange) {
        throw new Error("AI 修改范围已失效，请重新选择文本后再试。");
      }
      const previewSlice = buildEditorRewriteSlice(
        editor,
        content,
        rewriteSession.targetType === "image" ? [] : snapshot.placeholders,
      );
      if (!isEditorRewriteMarkdownPreviewReady(content, previewSlice)) {
        if (rewriteJob.status === "running") {
          return;
        }
        throw new Error("AI 返回内容没有可显示的正文。");
      }
      let currentFrom = rewriteSession.modifyPreview?.currentFrom ?? protectedRange.from;
      const currentTo = rewriteSession.modifyPreview?.currentTo ?? protectedRange.to;

      aiPreviewMutationRef.current = true;
      let nextTo = currentTo;
      try {
        if (rewriteSession.modifyPreview?.showing === "original") {
          nextTo = currentTo;
        } else if (rewriteSession.targetType === "image" && !rewriteSession.modifyPreview) {
          const insertPosition = getInsertPositionAfterSelectedBlock(editor, snapshot.to);
          setEditorRewriteProtectedRange(editor, null, rewriteSession.targetKey);
          const inserted = insertEditorPreviewSlice(editor, insertPosition, previewSlice);
          currentFrom = inserted.from;
          nextTo = inserted.to;
          setEditorRewriteProtectedRange(editor, {
            from: snapshot.from,
            to: nextTo,
          }, rewriteSession.targetKey);
        } else {
          nextTo = replaceEditorRangeWithSlice(editor, currentFrom, currentTo, previewSlice);
          setEditorRewriteProtectedRange(editor, {
            from: rewriteSession.targetType === "image" ? snapshot.from : currentFrom,
            to: nextTo,
          }, rewriteSession.targetKey);
        }
      } finally {
        aiPreviewMutationRef.current = false;
      }

      setRewriteSession((current) => current?.targetKey !== rewriteSession.targetKey ? current : {
        ...current,
        anchorPos: nextTo,
        answer: visibleAutomaticAnswer,
        modifyPreview: {
          originalMarkdown: snapshot.markdown,
          modifiedMarkdown: content,
          placeholders: snapshot.placeholders,
          originalSlice: rewriteSession.targetType === "image" ? Slice.empty : snapshot.originalSlice,
          currentFrom,
          currentTo: nextTo,
          showing: rewriteSession.modifyPreview?.showing ?? "modified",
        },
      });
    } catch (error) {
      rollbackRewritePreview(rewriteSession);
      setEditorRewriteProtectedRange(editor, null, rewriteSession.targetKey);
      rewriteSessionRef.current = null;
      setRewriteSession(null);
      pushToast({
        tone: "error",
        title: "应用 AI 结果失败",
        detail: error instanceof Error ? error.message : "AI 结果无法写回编辑器",
      });
    }
  }, [editor, pushToast, rewriteJob, rewriteSession, rollbackRewritePreview]);

  useEffect(() => {
    if (!editor || !rewriteSession || (rewriteJob?.status !== "failed" && rewriteJob?.status !== "cancelled")) {
      return;
    }
    if (rewriteSession.modifyPreview) {
      rollbackRewritePreview(rewriteSession);
      setEditorRewriteProtectedRange(editor, {
        from: rewriteSession.selectionSnapshot.from,
        to: rewriteSession.selectionSnapshot.to,
      }, rewriteSession.targetKey);
      setRewriteSession((current) => current?.targetKey !== rewriteSession.targetKey
        ? current
        : { ...current, modifyPreview: null });
    }
  }, [editor, rewriteJob?.status, rewriteSession, rollbackRewritePreview]);

  useEffect(() => {
    if (!rewriteSession?.modifyPreview || rewriteSession.modifyPreview.showing !== "original") {
      return;
    }

    const restoreModified = () => {
      replaceAiPreviewMarkdown(rewriteSession.modifyPreview?.modifiedMarkdown ?? "", "modified");
    };

    window.addEventListener("blur", restoreModified);
    return () => window.removeEventListener("blur", restoreModified);
  }, [replaceAiPreviewMarkdown, rewriteSession]);

  rewriteWidgetCallbacksRef.current = {
    onAccept: () => {
      acceptModifyPreview();
    },
    onReject: () => {
      rejectModifyPreview();
    },
    onCompareDown: () => {
      const session = rewriteSessionRef.current;
      if (session?.modifyPreview) {
        replaceAiPreviewMarkdown(session.modifyPreview.originalMarkdown, "original");
      }
    },
    onCompareUp: () => {
      const session = rewriteSessionRef.current;
      if (session?.modifyPreview) {
        replaceAiPreviewMarkdown(session.modifyPreview.modifiedMarkdown, "modified");
      }
    },
    onRetry: () => {
      retryAiSession();
    },
    onCopyAnswer: () => {
      copyAiAnswer();
    },
    onInsertAnswer: () => {
      insertAiAnswer();
    },
    onPreserveViewport: () => {
      if (editor) {
        preserveEditorViewport(editor, { releaseAfterMs: 1_000 });
      }
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

    const protectionPlugin = createEditorRewriteProtectionPlugin({
      onBlocked: () => {
        pushToast({
          tone: "info",
          title: "AI 选区正在修改",
          detail: "这部分内容已暂时冻结，你仍可编辑选区之外的内容。",
        });
      },
    });
    const plugin = createEditorRewriteWidgetPlugin({
      getWidgetState: () => rewriteWidgetStateRef.current,
      getProtectedRange: () => {
        const session = rewriteSessionRef.current;
        return session ? getEditorRewriteProtectedRange(editor, session.targetKey) : null;
      },
      getCallbacks: () => rewriteWidgetCallbacksRef.current,
    });

    editor.registerPlugin(protectionPlugin);
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(RICH_EDITOR_REWRITE_WIDGET_PLUGIN_KEY);
      editor.unregisterPlugin(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY);
    };
  }, [editor, pushToast]);

  const handleContextMenuPaste = useCallback(() => {
    if (!editor) {
      return;
    }

    return runEditorPasteCommand(editor, {
      onPasteHtml: (html, restoreTarget) =>
        handlePastedHtml(editor.view, html, restoreTarget),
      onPasteImages: (files, restoreTarget) =>
        handlePastedImages(editor.view, files, restoreTarget),
      onFailure: () =>
        pushToast({
          tone: "error",
          title: "粘贴失败",
          detail: "剪贴板内容无法安全插入。",
        }),
    });
  }, [editor, handlePastedHtml, handlePastedImages, pushToast]);

  const handleEditorContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!editor) {
        return;
      }

      if (shouldIgnoreRichEditorContextMenuTarget(event.target)) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const eventPath =
        typeof event.nativeEvent.composedPath === "function"
          ? event.nativeEvent.composedPath()
          : [];
      const attachmentTarget = resolveAttachmentContextMenuTarget(editor, target, eventPath);

      if (attachmentTarget) {
        selectNodeAtPos(editor, attachmentTarget.nodePos);
        event.preventDefault();
        event.stopPropagation();
        setAiMenu(null);
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          ariaLabel: "文件操作",
          actions: buildAttachmentContextMenuActions({
            editor,
            attachmentTarget,
            readOnly: effectiveReadOnly,
          }),
          autoFocus: false,
        });
        return;
      }

      const contextMenuAnchorPos = resolveContextMenuAnchorPos(editor, target, {
        left: event.clientX,
        top: event.clientY,
      });
      const hasTextSelection =
        syncDomTextSelectionToEditor(editor, contextMenuAnchorPos) ||
        syncStoredTextSelectionToEditor(editor, storedTextSelectionRef.current, {
          anchorPos: contextMenuAnchorPos,
        }) ||
        (hasExpandedTextSelection(editor) &&
          (contextMenuAnchorPos === null ||
            isPosWithinSelection(editor, contextMenuAnchorPos)));

      if (!hasTextSelection && contextMenuAnchorPos !== null) {
        setContextMenuInsertionTarget(editor, contextMenuAnchorPos);
      }

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
            onCopyImage: () => {
              void copyImageToClipboard(editor, imageTarget).then((copied) => {
                pushToast({
                  tone: copied ? "success" : "error",
                  title: copied ? "图片已复制" : "复制图片失败",
                  detail: copied ? undefined : "当前环境无法写入图片剪贴板。",
                });
              });
            },
            readOnly: effectiveReadOnly,
            editorSkills: enabledImageSkills,
            unavailableReason: imageInterpretationFormatUnavailableReason(imageTarget)
              ?? (aiSettings?.aiSecretsUnlocked === false
              ? "需先解锁 AI 配置"
              : !imageInterpretationReady
                ? "需先配置支持图片的 AI 模型"
                : null),
            onOpenAiSettings,
            onRunEditorSkill: (skill) => runImageInterpretationAction(skill, imageTarget),
            onOpenAiPrompt: () => {
              preserveEditorViewport(editor);
              setContextMenu(null);
              setAiMenu({
                x: event.clientX,
                y: event.clientY,
                targetType: "image",
                imageTarget,
              });
            },
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
            ? buildRichEditorSelectionPayload(editor, {
                removeSelectionAndSave,
              })
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
              defaultCodeLanguage,
              editorSkills: enabledEditorSkills,
              rewriteUnavailableReason,
              onOpenAiSettings,
              onOpenAiEdit: () => {
                setContextMenu(null);
                setAiMenu({
                  x: event.clientX,
                  y: event.clientY,
                  targetType: "text",
                });
              },
              onRunEditorSkill: runEditorRewriteAction,
              onUnavailableAction: (title) =>
                pushToast({
                  tone: "info",
                  title,
                  detail: "能力建设中",
                }),
              onPaste: handleContextMenuPaste,
            }),
            autoFocus: false,
          });
          return;
        }

        setAiMenu(null);
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          ariaLabel: "文本操作",
          actions: buildTextContextMenuActions({
            editor,
            readOnly: effectiveReadOnly,
            hasTextSelection,
            insertTable: enableTables ? insertTable : undefined,
            onInsertImage: handleInsertImage,
            onInsertFile: handleInsertFile,
            canInsertImage: Boolean(assetHandlers?.insertImage),
            canInsertFile: Boolean(assetHandlers?.insertFile),
            assetBusy,
            defaultCodeLanguage,
            editorSkills: enabledEditorSkills,
            rewriteUnavailableReason,
            onOpenAiSettings,
            onOpenAiEdit: () => {
              setContextMenu(null);
              setAiMenu({
                x: event.clientX,
                y: event.clientY,
                targetType: "text",
              });
            },
            onRunEditorSkill: runEditorRewriteAction,
            onUnavailableAction: (title) =>
              pushToast({
                tone: "info",
                title,
                detail: "能力建设中",
              }),
            onPaste: handleContextMenuPaste,
          }),
          autoFocus: false,
        });
        return;
      }

      setContextMenu(null);
      setAiMenu(null);
    },
    [
      editor,
      effectiveReadOnly,
      enableTables,
      enabledEditorSkills,
      enabledImageSkills,
      aiSettings?.aiSecretsUnlocked,
      imageInterpretationReady,
      onOpenAiSettings,
      openImageAnnotationDialog,
      assetBusy,
      assetHandlers?.insertFile,
      assetHandlers?.insertImage,
      handleInsertFile,
      handleInsertImage,
      handleContextMenuPaste,
      insertTable,
      pushToast,
      removeSelectionAndSave,
      runEditorRewriteAction,
      runImageInterpretationAction,
      selectionActions,
      rewriteUnavailableReason,
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
          run: () => toggleCodeBlockWithDefault(editor, defaultCodeLanguage),
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
    defaultCodeLanguage,
    editor,
    enableTables,
    handleInsertFile,
    handleInsertImage,
    insertTable,
    readOnly,
    uiTick,
  ]);

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
      {(variant === "toolbar" || variant === "page") && showToolbar ? (
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

      {/* Remove table insert button from bare variant - now in context menu */}
      {false && variant === "bare" && enableTables && !effectiveReadOnly && isFocused ? (
        <div className="rich-editor__bare-actions">
          <TableInsertButton compact onInsert={insertTable} />
        </div>
      ) : null}

      {activeCodeBlockInfo && (codeLanguagePanelOpen || codeLanguageContextMenuOpen) ? (
        <CodeLanguageFloatingToolbar
          ref={codeToolbarRef}
          position={codeToolbarPosition}
          language={activeCodeBlockInfo.language}
          query={codeLanguageQuery}
          open={codeLanguagePanelOpen}
          contextMenuOpen={codeLanguageContextMenuOpen}
          onQueryChange={setCodeLanguageQuery}
          onOpenChange={setCodeLanguagePanelOpen}
          onContextMenuOpenChange={setCodeLanguageContextMenuOpen}
          onApplyToDocument={applyCurrentCodeLanguageToDocument}
          onSelect={applyCodeLanguage}
        />
      ) : null}

      <div
        ref={frameRef}
        className="rich-editor__frame"
        onKeyDownCapture={(event) => {
          if (
            !event.nativeEvent.isComposing &&
            event.key.toLowerCase() === "f" &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            event.stopPropagation();
            openEditorSearch();
          }
        }}
        onPointerDownCapture={handleFramePointerDownCapture}
        onMouseDownCapture={handleFrameMouseDownCapture}
        onClickCapture={handleFrameClick}
        onDoubleClick={handleEditorDoubleClick}
        onContextMenuCapture={handleEditorContextMenu}
      >
        {tableToolbarGroups.length > 0 ? (
          <div
            ref={tableToolbarRef}
            className={[
              "rich-editor__table-toolbar",
              "rich-editor__table-toolbar--floating",
              variant === "bare" ? "rich-editor__table-toolbar--bare" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              left: `${tableToolbarPosition?.left ?? 0}px`,
              top: `${tableToolbarPosition?.top ?? 0}px`,
              visibility: tableToolbarPosition ? "visible" : "hidden",
            }}
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

        {searchOpen ? (
          <div className="rich-editor__search-panel" role="dialog" aria-label="文本搜索">
            <div className="rich-editor__search-row">
              <input
                ref={searchInputRef}
                className="rich-editor__search-input"
                aria-label="搜索正文"
                placeholder="搜索"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) {
                    return;
                  }

                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (event.shiftKey) {
                      goToPreviousSearchMatch();
                    } else {
                      goToNextSearchMatch();
                    }
                  }

                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeEditorSearch();
                  }
                }}
              />
              <span className="rich-editor__search-count" aria-label="搜索结果数量">
                {searchMatches.length > 0 ? activeSearchIndex + 1 : 0} / {searchMatches.length}
              </span>
              <ToolbarButton
                type="button"
                aria-label="上一个匹配"
                title="上一个匹配"
                disabled={searchMatches.length === 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={goToPreviousSearchMatch}
              >
                <ChevronUp size={15} />
              </ToolbarButton>
              <ToolbarButton
                type="button"
                aria-label="下一个匹配"
                title="下一个匹配"
                disabled={searchMatches.length === 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={goToNextSearchMatch}
              >
                <ChevronDown size={15} />
              </ToolbarButton>
              <ToolbarButton
                type="button"
                aria-label="关闭搜索"
                title="关闭搜索"
                onMouseDown={(event) => event.preventDefault()}
                onClick={closeEditorSearch}
              >
                <X size={15} />
              </ToolbarButton>
            </div>
            {!effectiveReadOnly ? (
              <div className="rich-editor__search-row">
                <input
                  className="rich-editor__search-input"
                  aria-label="替换为"
                  placeholder="替换为"
                  value={replaceQuery}
                  onChange={(event) => setReplaceQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeEditorSearch();
                    }
                  }}
                />
                <button
                  type="button"
                  className="rich-editor__search-action"
                  disabled={searchMatches.length === 0}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={replaceCurrentSearchMatch}
                >
                  替换
                </button>
                <button
                  type="button"
                  className="rich-editor__search-action"
                  disabled={searchMatches.length === 0}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={replaceAllSearchMatches}
                >
                  全部
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <EditorContent editor={editor} onBlur={(event) => void handleBlur(event.relatedTarget)} />

        {rewriteSessions.length > 1 ? (
          <div className="rich-editor__skill-session-stack" role="list" aria-label="其他 AI 会话">
            {rewriteSessions.slice(0, -1).map((session) => {
              const jobId = latestAiJobIdByTarget[session.targetKey];
              const job = jobId ? aiJobsById[jobId] : null;
              return (
                <div key={session.targetKey} role="listitem" className="rich-editor__rewrite-widget-card rich-editor__rewrite-widget-card--line">
                  <span>{session.skill.name} · {job?.status === "succeeded" ? "待审阅" : job?.status === "failed" ? "失败" : "处理中"}</span>
                  <button type="button" className="rich-editor__rewrite-widget-action" onClick={() => activateEditorSkillSession(session.targetKey)}>
                    查看
                  </button>
                  <button type="button" className="rich-editor__rewrite-widget-action" aria-label={`关闭 ${session.skill.name} AI 会话`} onClick={() => closeEditorSkillSession(session.targetKey)}>
                    关闭
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {referencePicker && internalReferences?.context && !effectiveReadOnly ? (
          <InternalReferencePicker
            open
            loading={referenceLoading}
            results={referenceResults}
            activeIndex={referenceActiveIndex}
            portal
            className="fixed z-[120] w-[22rem]"
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
            portal
            className="fixed z-[120]"
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
        {tagPicker && tagMentionsEnabled && !effectiveReadOnly ? (
          <TagMentionPicker
            open
            loading={tagLoading}
            results={tagResults}
            activeIndex={tagActiveIndex}
            query={tagPicker.query}
            canCreate={tagCreatable}
            portal
            className="fixed z-[120]"
            style={{
              left: `${tagPicker.position.left}px`,
              top: `${tagPicker.position.top}px`,
            }}
            onHoverIndex={setTagActiveIndex}
            onSelect={(tag) => {
              void handleSelectTagMention(editor.view, tag);
            }}
            onCreate={(label) => {
              void handleCreateTagMention(editor.view, label);
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
          disabledReason={aiMenu.targetType === "image"
            ? (aiSettings?.aiSecretsUnlocked === false
                ? "需先解锁 AI 配置"
                : !imageInterpretationReady
                  ? "需先配置支持图片的 AI 模型"
                  : null)
            : rewriteUnavailableReason}
          targetType={aiMenu.targetType}
          onClose={closeAiMenu}
          onSubmitPrompt={runAiMenuPrompt}
        />
      ) : null}
      {annotationDialog ? (
        <Suspense
          fallback={
            <div
              className="fixed inset-0 z-[140] grid place-items-center bg-black/20 text-sm text-text-muted"
              role="status"
            >
              正在加载图片标注…
            </div>
          }
        >
          <ImageAnnotationDialog
            open
            readOnly={readOnly}
            title={annotationDialog.title}
            imageSrc={annotationDialog.imageSrc}
            fallbackImageSrc={annotationDialog.fallbackImageSrc}
            initialAnnotationState={annotationDialog.annotationState}
            imageSize={annotationDialog.imageSize}
            onClose={() => setAnnotationDialog(null)}
            onSave={handleAnnotationSave}
          />
        </Suspense>
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

const CodeLanguageFloatingToolbar = forwardRef<
  HTMLDivElement,
  {
    position: CodeToolbarPosition | null;
    language: string;
    query: string;
    open: boolean;
    contextMenuOpen: boolean;
    onQueryChange: (query: string) => void;
    onOpenChange: (open: boolean) => void;
    onContextMenuOpenChange: (open: boolean) => void;
    onApplyToDocument: () => void;
    onSelect: (language: string | null) => void;
  }
>(function CodeLanguageFloatingToolbar(
  {
    position,
    language,
    query,
    open,
    contextMenuOpen,
    onQueryChange,
    onOpenChange,
    onContextMenuOpenChange,
    onApplyToDocument,
    onSelect,
  },
  ref,
) {
  const options = useMemo(() => filterCodeLanguageOptions(query).slice(0, 12), [query]);
  const normalizedLanguage = normalizeCodeLanguage(language);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionIds = useMemo<(string | null)[]>(() => [null, ...options.map((option) => option.id)], [options]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open && !contextMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;

      if (target && rootRef.current?.contains(target)) {
        return;
      }

      onOpenChange(false);
      onContextMenuOpenChange(false);
      onQueryChange("");
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      onOpenChange(false);
      onContextMenuOpenChange(false);
      onQueryChange("");
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenuOpen, onContextMenuOpenChange, onOpenChange, onQueryChange, open]);

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;

      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  const commitLanguage = (nextLanguage: string | null) => {
    onSelect(nextLanguage);
    onOpenChange(false);
    onContextMenuOpenChange(false);
  };

  const runContextAction = (action: () => void) => {
    action();
    onOpenChange(false);
    onContextMenuOpenChange(false);
    onQueryChange("");
  };

  return (
    <div
      ref={setRefs}
      className="rich-editor__code-language-popover rich-editor__code-language-popover--open"
      style={{
        left: `${position?.left ?? 0}px`,
        top: `${position?.top ?? 0}px`,
        visibility: position ? "visible" : "hidden",
      }}
      aria-label="代码类型"
    >
      {contextMenuOpen ? (
        <div className="rich-editor__code-language-context-panel" role="menu" aria-label="代码类型应用范围">
          <button
            type="button"
            className="rich-editor__code-language-context-option"
            role="menuitem"
            disabled={!normalizedLanguage}
            onClick={() => runContextAction(onApplyToDocument)}
          >
            应用到整个文档
          </button>
        </div>
      ) : null}

      {open ? (
        <div className="rich-editor__code-language-panel">
          <div className="rich-editor__code-language-panel-header">
            <input
              ref={inputRef}
              className="rich-editor__code-language-search"
              value={query}
              placeholder="Search language"
              aria-label="搜索代码语言"
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((current) => Math.min(current + 1, Math.max(optionIds.length - 1, 0)));
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) => Math.max(current - 1, 0));
                }

                if (event.key === "Enter") {
                  event.preventDefault();
                  commitLanguage(optionIds[activeIndex] ?? optionIds[0] ?? null);
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  onOpenChange(false);
                  onQueryChange("");
                }
              }}
            />
          </div>
          <div className="rich-editor__code-language-list" role="listbox">
            <button
              type="button"
              className={[
                "rich-editor__code-language-option",
                normalizedLanguage === "" ? "rich-editor__code-language-option--selected" : "",
                activeIndex === 0 ? "rich-editor__code-language-option--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onMouseEnter={() => setActiveIndex(0)}
              onClick={() => commitLanguage(null)}
            >
              Plain Text
            </button>
            {options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                className={[
                  "rich-editor__code-language-option",
                  normalizedLanguage === option.id ? "rich-editor__code-language-option--selected" : "",
                  activeIndex === index + 1 ? "rich-editor__code-language-option--active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setActiveIndex(index + 1)}
                onClick={() => commitLanguage(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});

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
      editor.commands.focus(focusPosition.pos, { scrollIntoView: false });
      return;
    }

    // Keep the current selection when a viewport hit-test misses on a retry.
    editor.commands.focus(undefined, { scrollIntoView: false });
    return;
  }

  editor.commands.focus("end", { scrollIntoView: false });
}

function resolveRelativeAutoFocusPoint(editor: Editor, autoFocus: RichEditorAutoFocusPoint) {
  const rect = editor.view.dom.getBoundingClientRect();

  return {
    left: rect.left + autoFocus.x,
    top: rect.top + autoFocus.y,
  };
}

function insertTagMentionNode(
  view: EditorView,
  trigger: { start: number; end: number },
  tag: ProjectTagRecord,
) {
  const nodeType = view.state.schema.nodes.tagMention;

  if (!nodeType) {
    return false;
  }

  const tr = view.state.tr.delete(trigger.start, trigger.end);
  const tagNode = nodeType.create({
    tagId: tag.id,
    label: tag.label,
    colorKey: tag.colorKey,
  });
  tr.insert(trigger.start, tagNode);
  const nextSelectionPos = trigger.start + tagNode.nodeSize;
  tr.insertText(" ", nextSelectionPos);
  tr.setSelection(TextSelection.create(tr.doc, nextSelectionPos + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
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
  const caretRect = editor.view.coordsAtPos(selection.from);

  return {
    start: absoluteStart,
    end: selection.from,
    query: trigger.query,
    position: {
      left: Math.max(8, caretRect.left),
      top: Math.max(8, caretRect.bottom + 8),
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
  const caretRect = editor.view.coordsAtPos(selection.from);

  return {
    start: absoluteStart,
    end: selection.from,
    query: trigger.query,
    position: {
      left: Math.max(8, caretRect.left),
      top: Math.max(8, caretRect.bottom + 8),
    },
  };
}

function resolveEditorTagTrigger(
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

  const trigger = findHashTagTextTrigger(
    editor.state.doc.textBetween(selection.$from.start(), selection.from, "\n", "\0"),
    selection.$from.parentOffset,
  );

  if (!trigger) {
    return null;
  }

  const absoluteStart = selection.from - trigger.query.length - 1;
  const caretRect = editor.view.coordsAtPos(selection.from);

  return {
    start: absoluteStart,
    end: selection.from,
    query: trigger.query,
    position: {
      left: Math.max(8, caretRect.left),
      top: Math.max(8, caretRect.bottom + 8),
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

function resolveActiveListItemType(editor: Editor): "listItem" | "taskItem" | null {
  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeTypeName = $from.node(depth).type.name;

    if (nodeTypeName === "listItem" || nodeTypeName === "taskItem") {
      return nodeTypeName;
    }
  }

  return null;
}

function handleListIndentation(editor: Editor, outdent: boolean) {
  const listItemType = resolveActiveListItemType(editor);

  if (!listItemType) {
    return false;
  }

  const chain = editor.chain().focus();

  return outdent
    ? chain.liftListItem(listItemType).run()
    : chain.sinkListItem(listItemType).run();
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

  normalizePastedTaskLists(doc);

  doc.querySelectorAll("script, style, iframe, object, embed, form, input, button").forEach((element) => {
    element.remove();
  });

  doc.querySelectorAll("u, mark, font").forEach((element) => {
    element.replaceWith(...Array.from(element.childNodes));
  });

  doc.querySelectorAll("*").forEach((element) => {
    const className = element.getAttribute("class");

    if (className && (!element.matches("code[class^='language-']") || className.includes("Mso"))) {
      element.removeAttribute("class");
    }

    element.removeAttribute("style");
    element.removeAttribute("id");
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  return trimTrailingCodeBlockNewline(doc.body.innerHTML);
}

function normalizePastedTaskLists(doc: Document) {
  const checkboxes = Array.from(
    doc.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );

  for (const checkbox of checkboxes) {
    const item = checkbox.closest("li");
    const sourceList = item?.parentElement;

    if (!item || !sourceList || !sourceList.matches("ul, ol")) {
      checkbox.remove();
      continue;
    }

    let taskList = sourceList;

    if (sourceList.tagName === "OL") {
      taskList = doc.createElement("ul");
      taskList.replaceChildren(...Array.from(sourceList.childNodes));
      sourceList.replaceWith(taskList);
    }

    taskList.setAttribute("data-type", "taskList");
    item.setAttribute("data-type", "taskItem");
    item.setAttribute("data-checked", String(checkbox.checked));
    checkbox.remove();
  }
}

function replaceEditorContentWithoutHistory(editor: Editor, nextHtml: string) {
  const currentDoc = editor.state.doc;
  const nextDoc = createDocument(
    nextHtml,
    editor.schema,
    editor.options.parseOptions,
    { errorOnInvalidContent: editor.options.enableContentCheck },
  );
  const start = currentDoc.content.findDiffStart(nextDoc.content);

  if (start === null) {
    return;
  }

  const end = currentDoc.content.findDiffEnd(
    nextDoc.content,
    currentDoc.content.size,
    nextDoc.content.size,
  );

  if (!end) {
    return;
  }

  let endCurrent = end.a;
  let endNext = end.b;
  const overlap = start - Math.min(endCurrent, endNext);

  if (overlap > 0) {
    endCurrent += overlap;
    endNext += overlap;
  }

  // Saved server echoes can legitimately change metadata (for example an
  // embedded image URL). Apply only that diff and map existing history through
  // it, without presenting the echo as a user-editable undo step.
  editor.view.dispatch(
    editor.state.tr
      .replace(start, endCurrent, nextDoc.slice(start, endNext))
      .setMeta("addToHistory", false)
      .setMeta("preventUpdate", true),
  );
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

function serializeCommittedEditor(
  editor: Editor,
  sessions: readonly EditorSkillSessionState[],
): RichEditorValue {
  const previews = sessions
    .flatMap((session) => session.modifyPreview && session.modifyPreview.showing !== "original"
      ? [{ session, preview: session.modifyPreview }]
      : [])
    .sort((left, right) => right.preview.currentFrom - left.preview.currentFrom);
  if (previews.length === 0) {
    return serializeEditor(editor);
  }
  let projection = editor.state.tr;
  for (const { preview } of previews) {
    projection = projection.replaceRange(preview.currentFrom, preview.currentTo, preview.originalSlice);
  }
  const projectedDoc = projection.doc;
  const container = document.createElement("div");
  container.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(projectedDoc.content));
  return {
    html: normalizeHtml(container.innerHTML),
    text: projectedDoc.textBetween(0, projectedDoc.content.size, "\n\n"),
    markdown: serializeRichTextNodesMarkdown(editor, projectedDoc.content.content),
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

function buildRichEditorSelectionPayload(
  editor: Editor,
  options: {
    removeSelectionAndSave: (range: { from: number; to: number }) => Promise<unknown>;
  },
): RichEditorSelectionPayload | null {
  const { selection: editorSelection } = editor.state;
  const selection = buildEditorRewriteSelection(editor);

  if (!selection || !selection.expandedMarkdown.trim()) {
    return null;
  }

  return {
    text: selection.selectedText.trim(),
    markdown: selection.expandedMarkdown.trim(),
    html: selection.selectedHtml || renderMarkdownToHtml(selection.expandedMarkdown),
    removeSelectionAndSave: () =>
      options.removeSelectionAndSave({
        from: editorSelection.from,
        to: editorSelection.to,
      }),
  };
}

function buildSelectionContextMenuActions({
  editor,
  readOnly,
  selectionActions,
  selectionPayload,
  defaultCodeLanguage,
  editorSkills,
  rewriteUnavailableReason,
  onOpenAiSettings,
  onOpenAiEdit,
  onRunEditorSkill,
  onUnavailableAction,
  onPaste,
}: {
  editor: Editor;
  readOnly: boolean;
  selectionActions: RichEditorSelectionAction[];
  selectionPayload: RichEditorSelectionPayload;
  defaultCodeLanguage?: string | null;
  editorSkills: AiSettingsSnapshot["editorSkills"];
  rewriteUnavailableReason?: string | null;
  onOpenAiSettings?: () => void;
  onOpenAiEdit: () => void;
  onRunEditorSkill: (skill: AiSettingsSnapshot["editorSkills"][number]) => void;
  onUnavailableAction: (title: string) => void;
  onPaste?: () => void | Promise<void>;
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

  const textActions = buildTextContextMenuActions({
    editor,
    readOnly,
    hasTextSelection: true,
    defaultCodeLanguage,
    editorSkills,
    rewriteUnavailableReason,
    onOpenAiSettings,
    onOpenAiEdit,
    onRunEditorSkill,
    onUnavailableAction,
    onPaste,
  });
  const clipboardActions = textActions.slice(0, 2);
  const remainingTextActions = textActions.slice(2);

  return [
    ...clipboardActions,
    ...customActions,
    { type: "separator", key: "selection-actions-separator" } satisfies ContextMenuAction,
    ...remainingTextActions,
  ];
}

function buildTextContextMenuActions({
  editor,
  readOnly,
  hasTextSelection,
  insertTable,
  onInsertImage,
  onInsertFile,
  canInsertImage = false,
  canInsertFile = false,
  assetBusy = null,
  defaultCodeLanguage,
  editorSkills = [],
  rewriteUnavailableReason,
  onOpenAiSettings,
  onOpenAiEdit,
  onRunEditorSkill,
  onUnavailableAction,
  onPaste,
}: {
  editor: Editor;
  readOnly: boolean;
  hasTextSelection: boolean;
  insertTable?: (rows?: number, cols?: number) => void;
  onInsertImage?: () => void | Promise<void>;
  onInsertFile?: () => void | Promise<void>;
  canInsertImage?: boolean;
  canInsertFile?: boolean;
  assetBusy?: null | "image" | "file";
  defaultCodeLanguage?: string | null;
  editorSkills?: AiSettingsSnapshot["editorSkills"];
  rewriteUnavailableReason?: string | null;
  onOpenAiSettings?: () => void;
  onOpenAiEdit?: () => void;
  onRunEditorSkill?: (skill: AiSettingsSnapshot["editorSkills"][number]) => void;
  onUnavailableAction?: (title: string) => void;
  onPaste?: () => void | Promise<void>;
}) {
  const canRun = (callback: (chain: any) => { run: () => boolean }) =>
    !readOnly && editor.isEditable && callback(editor.can().chain().focus()).run();
  const runCommand = (callback: (chain: any) => { run: () => boolean }) => () => {
    callback(editor.chain().focus()).run();
  };

  const clipboardActions: ContextMenuAction = {
    type: "quick-actions",
    key: "text-clipboard-actions",
    ariaLabel: "剪贴板",
    actions: [
      {
        key: "text-cut",
        label: "剪切",
        icon: Scissors,
        disabled: readOnly || !editor.isEditable,
        onSelect: () => {
          void runEditorClipboardCommand(editor, "cut");
        },
      },
      {
        key: "text-copy",
        label: "复制",
        icon: Copy,
        disabled: false,
        onSelect: () => {
          void runEditorClipboardCommand(editor, "copy");
        },
      },
      {
        key: "text-paste",
        label: "粘贴",
        icon: Paperclip,
        disabled: readOnly || !editor.isEditable,
        onSelect: () => {
          void (onPaste?.() ?? runEditorPasteCommand(editor));
        },
      },
    ],
  };

  const formatActions = [
    {
      key: "text-highlight",
      label: "着重",
      icon: Highlighter,
      active: editor.isActive("highlight"),
      disabled: !canRun((chain) => chain.toggleHighlight()),
      onSelect: runCommand((chain) => chain.toggleHighlight()),
    },
    {
      key: "text-bold",
      label: "加粗",
      icon: Bold,
      active: editor.isActive("bold"),
      disabled: !canRun((chain) => chain.toggleBold()),
      onSelect: runCommand((chain) => chain.toggleBold()),
    },
    {
      key: "text-italic",
      label: "斜体",
      icon: Italic,
      active: editor.isActive("italic"),
      disabled: !canRun((chain) => chain.toggleItalic()),
      onSelect: runCommand((chain) => chain.toggleItalic()),
    },
    {
      key: "text-strike",
      label: "删除线",
      icon: Strikethrough,
      active: editor.isActive("strike"),
      disabled: !canRun((chain) => chain.toggleStrike()),
      onSelect: runCommand((chain) => chain.toggleStrike()),
    },
    {
      key: "text-code",
      label: "代码",
      icon: Code2,
      active: editor.isActive("code"),
      disabled: !canRun((chain) => chain.toggleCode()),
      onSelect: runCommand((chain) => chain.toggleCode()),
    },
  ];

  const blockShortcutActions = [
    {
      key: "shortcut-h1",
      label: "标题 1",
      icon: Heading1,
      active: editor.isActive("heading", { level: 1 }),
      disabled: !canRun((chain) => chain.toggleHeading({ level: 1 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 1 })),
    },
    {
      key: "shortcut-h2",
      label: "标题 2",
      icon: Heading2,
      active: editor.isActive("heading", { level: 2 }),
      disabled: !canRun((chain) => chain.toggleHeading({ level: 2 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 2 })),
    },
    {
      key: "shortcut-h3",
      label: "标题 3",
      icon: Heading3,
      active: editor.isActive("heading", { level: 3 }),
      disabled: !canRun((chain) => chain.toggleHeading({ level: 3 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 3 })),
    },
    {
      key: "shortcut-blockquote",
      label: "引用",
      icon: Quote,
      active: editor.isActive("blockquote"),
      disabled: !canRun((chain) => chain.toggleBlockquote()),
      onSelect: runCommand((chain) => chain.toggleBlockquote()),
    },
    {
      key: "shortcut-task-list",
      label: "Todo",
      icon: ListTodo,
      active: editor.isActive("taskList"),
      disabled: !canRun((chain) => chain.toggleTaskList()),
      onSelect: runCommand((chain) => chain.toggleTaskList()),
    },
  ];

  const blockOptions = [
    {
      key: "text-paragraph",
      label: "文本",
      mainLabel: "普通文本",
      icon: Type,
      active: () =>
        editor.isActive("paragraph") &&
        !editor.isActive("blockquote") &&
        !editor.isActive("heading") &&
        !editor.isActive("bulletList") &&
        !editor.isActive("orderedList") &&
        !editor.isActive("taskList") &&
        !editor.isActive("codeBlock"),
      disabled: !canRun((chain) => chain.setParagraph()),
      onSelect: runCommand((chain) => chain.setParagraph()),
    },
    {
      key: "text-h1",
      label: "标题 1",
      mainLabel: "标题 1",
      icon: Heading1,
      active: () => editor.isActive("heading", { level: 1 }),
      disabled: !canRun((chain) => chain.toggleHeading({ level: 1 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 1 })),
    },
    {
      key: "text-h2",
      label: "标题 2",
      mainLabel: "标题 2",
      icon: Heading2,
      active: () => editor.isActive("heading", { level: 2 }),
      disabled: !canRun((chain) => chain.toggleHeading({ level: 2 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 2 })),
    },
    {
      key: "text-h3",
      label: "标题 3",
      mainLabel: "标题 3",
      icon: Heading3,
      active: () => editor.isActive("heading", { level: 3 }),
      disabled: !canRun((chain) => chain.toggleHeading({ level: 3 })),
      onSelect: runCommand((chain) => chain.toggleHeading({ level: 3 })),
    },
    {
      key: "text-bullet-list",
      label: "项目符号列表",
      mainLabel: "项目符号列表",
      icon: List,
      active: () => editor.isActive("bulletList"),
      disabled: !canRun((chain) => chain.toggleBulletList()),
      onSelect: runCommand((chain) => chain.toggleBulletList()),
    },
    {
      key: "text-ordered-list",
      label: "有序列表",
      mainLabel: "有序列表",
      icon: ListOrdered,
      active: () => editor.isActive("orderedList"),
      disabled: !canRun((chain) => chain.toggleOrderedList()),
      onSelect: runCommand((chain) => chain.toggleOrderedList()),
    },
    {
      key: "text-task-list",
      label: "Todo 清单",
      mainLabel: "Todo 清单",
      icon: ListTodo,
      active: () => editor.isActive("taskList"),
      disabled: !canRun((chain) => chain.toggleTaskList()),
      onSelect: runCommand((chain) => chain.toggleTaskList()),
    },
    {
      key: "text-code-block",
      label: "代码",
      mainLabel: "代码",
      icon: Code2,
      active: () => editor.isActive("codeBlock"),
      disabled: !canRun((chain) => chain.toggleCodeBlock()),
      onSelect: () => {
        toggleCodeBlockWithDefault(editor, defaultCodeLanguage);
      },
    },
    {
      key: "text-blockquote",
      label: "引用",
      mainLabel: "引用",
      icon: Quote,
      active: () => editor.isActive("blockquote"),
      disabled: !canRun((chain) => chain.toggleBlockquote()),
      onSelect: runCommand((chain) => chain.toggleBlockquote()),
    },
  ];
  const currentBlock = blockOptions.find((option) => option.active()) ?? blockOptions[0];
  const blockMenuOrder = [
    "text-paragraph",
    "text-h1",
    "text-h2",
    "text-h3",
    "text-bullet-list",
    "text-ordered-list",
    "text-task-list",
    "text-code-block",
    "text-blockquote",
  ];
  const blockActions: ContextMenuAction[] = blockMenuOrder
    .map((key) => blockOptions.find((option) => option.key === key))
    .filter((option): option is (typeof blockOptions)[number] => Boolean(option))
    .map((option) => ({
      key: option.key,
      label: option.label,
      icon: option.icon,
      selected: option.active(),
      disabled: option.disabled,
      onSelect: option.onSelect,
    }));
  const isDisabledContextAction = (action: ContextMenuAction) =>
    action.type !== "separator" &&
    action.type !== "inline-actions" &&
    action.type !== "quick-actions" &&
    action.type !== "grid-actions" &&
    action.type !== "scroll-actions" &&
    action.type !== "section-label" &&
    Boolean(action.disabled);

  const groupedActions: ContextMenuAction[] = [
    clipboardActions,
    { type: "separator", key: "text-clipboard-separator" },
    {
      type: "submenu",
      key: "text-group-block",
      label: currentBlock.mainLabel,
      icon: currentBlock.icon,
      actions: blockActions,
      disabled: blockActions.every(isDisabledContextAction),
      selected: true,
      featured: true,
    },
    {
      type: "inline-actions",
      key: "text-inline-format-actions",
      ariaLabel: "行内文本格式",
      columns: 5,
      showLabels: false,
      actions: formatActions,
    },
    {
      type: "inline-actions",
      key: "text-block-shortcut-actions",
      ariaLabel: "常用块样式",
      columns: 5,
      showLabels: false,
      actions: blockShortcutActions,
    },
    { type: "separator", key: "text-inline-actions-separator" },
  ];

  if (hasTextSelection) {
    groupedActions.push(
      ...buildAiContextMenuActions({
        editorSkills,
        rewriteUnavailableReason,
        onOpenAiSettings,
        onOpenAiEdit,
        onRunEditorSkill,
        onUnavailableAction,
      }),
    );
  } else {
    groupedActions.push({
      type: "grid-actions",
      key: "insert-block-grid",
      title: "新增区块",
      ariaLabel: "新增区块",
      columns: 2,
      actions: [
        {
          key: "insert-blockquote",
          label: "引用",
          icon: Quote,
          disabled: !canRun((chain) => chain.toggleBlockquote()),
          onSelect: runCommand((chain) => chain.toggleBlockquote()),
        },
        {
          key: "insert-table",
          label: "表格",
          icon: Table2,
          disabled: readOnly || !insertTable,
          onSelect: () => insertTable?.(),
        },
        {
          key: "insert-image",
          label: "图片",
          icon: Image,
          disabled: readOnly || !canInsertImage || assetBusy !== null,
          onSelect: () => {
            void onInsertImage?.();
          },
        },
        {
          key: "insert-file",
          label: "文件",
          icon: FileIcon,
          disabled: readOnly || !canInsertFile || assetBusy !== null,
          onSelect: () => {
            void onInsertFile?.();
          },
        },
        {
          key: "insert-code-block",
          label: "代码块",
          icon: Code2,
          disabled: !canRun((chain) => chain.toggleCodeBlock()),
          onSelect: () => toggleCodeBlockWithDefault(editor, defaultCodeLanguage),
        },
        {
          key: "insert-task-list",
          label: "Todo",
          icon: ListTodo,
          disabled: !canRun((chain) => chain.toggleTaskList()),
          onSelect: runCommand((chain) => chain.toggleTaskList()),
        },
        {
          key: "insert-divider",
          label: "分隔线",
          icon: Minus,
          disabled: !canRun((chain) => chain.setHorizontalRule()),
          onSelect: runCommand((chain) => chain.setHorizontalRule()),
        },
        {
          key: "insert-more-blocks",
          label: "更多",
          icon: MoreHorizontal,
          disabled: true,
          onSelect: () => onUnavailableAction?.("更多"),
        },
      ],
    });
  }

  return groupedActions;
}

function buildAiContextMenuActions({
  editorSkills,
  rewriteUnavailableReason,
  onOpenAiSettings,
  onOpenAiEdit,
  onRunEditorSkill,
  onUnavailableAction,
}: {
  editorSkills: AiSettingsSnapshot["editorSkills"];
  rewriteUnavailableReason?: string | null;
  onOpenAiSettings?: () => void;
  onOpenAiEdit?: () => void;
  onRunEditorSkill?: (skill: AiSettingsSnapshot["editorSkills"][number]) => void;
  onUnavailableAction?: (title: string) => void;
}) {
  const visibleSkills = editorSkills.filter((skill) => skill.enabled && skill.showInTextMenu);

  return [
    {
      type: "section-label",
      key: "ai-skills-label",
      label: "技能",
      trailingIcon: Settings2,
      trailingLabel: "打开 AI 设置",
      trailingDisabled: !onOpenAiSettings,
      onTrailingSelect: onOpenAiSettings,
    },
    {
      type: "scroll-actions",
      key: "ai-skills-scroll",
      ariaLabel: "AI 技能列表",
      maxVisibleItems: 3,
      actions:
        visibleSkills.length > 0
          ? visibleSkills.map((skill) => ({
              key: `ai-skill-${skill.id}`,
              label: `${skill.icon?.trim() ? `${skill.icon.trim()} ` : ""}${skill.name}`,
              icon: skill.resultMode === "answer" ? Lightbulb : Sparkles,
              disabled: Boolean(rewriteUnavailableReason) || !onRunEditorSkill,
              onSelect: () => {
                if (!onRunEditorSkill) {
                  onUnavailableAction?.(skill.name);
                  return;
                }
                onRunEditorSkill(skill);
              },
            }))
          : [
              {
                key: "ai-no-skills",
                label: "暂无启用技能",
                icon: MoreHorizontal,
                disabled: true,
                onSelect: () => onUnavailableAction?.("暂无启用技能"),
              },
            ],
    },
    { type: "separator", key: "ai-editor-entry-separator" },
    {
      key: "ai-edit",
      label: "使用 AI 编辑",
      icon: WandSparkles,
      shortcut: "⌘ ^ E",
      disabled: !onOpenAiEdit,
      onSelect: () => onOpenAiEdit?.(),
    },
  ] satisfies ContextMenuAction[];
}

function getActiveCodeBlockInfo(editor: Editor): ActiveCodeBlockInfo | null {
  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);

    if (node.type.name !== "codeBlock") {
      continue;
    }

    const language = normalizeCodeLanguage(
      typeof node.attrs.language === "string" ? node.attrs.language : node.attrs.params,
    );

    return {
      pos: depth > 0 ? $from.before(depth) : 0,
      language,
    };
  }

  return null;
}

function getInsertPositionAfterSelectedBlock(editor: Editor, selectionTo: number): number {
  const docSize = editor.state.doc.content.size;
  const safeTo = clampNumber(selectionTo, 1, Math.max(1, docSize));
  const resolvePos = safeTo > 1 ? safeTo - 1 : safeTo;
  const $pos = editor.state.doc.resolve(resolvePos);

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.isBlock) {
      try {
        return $pos.after(depth);
      } catch {
        return selectionTo;
      }
    }
  }

  return selectionTo;
}

function replaceEditorRangeWithSlice(editor: Editor, from: number, to: number, slice: Slice) {
  const docSize = editor.state.doc.content.size;
  if (from < 0 || to < from || from > docSize || to > docSize) {
    throw new Error("AI 修改范围已失效，请重新选择文本后再试。");
  }

  if (from === to && !slice.content.size) {
    return to;
  }

  const transaction = markEditorRewriteTransaction(
    editor.state.tr.replaceRange(from, to, slice),
  ).setMeta("addToHistory", false);
  const nextTo = transaction.mapping.map(to, -1);
  editor.view.dispatch(transaction);
  editor.commands.focus(undefined, { scrollIntoView: false });
  return nextTo;
}

function isEditorRewriteMarkdownPreviewReady(markdown: string, slice: Slice) {
  return hasVisibleEditorRewriteContent(slice) && !hasIncompleteMarkdownStructure(markdown);
}

function hasIncompleteMarkdownStructure(markdown: string) {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const outsideFenceLines: string[] = [];

  for (const line of markdown.split(/\r?\n/u)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!fenceMatch) {
      if (!fence) outsideFenceLines.push(line);
      continue;
    }

    const markerRun = fenceMatch[1] ?? "";
    const marker = markerRun[0] as "`" | "~";
    const suffix = fenceMatch[2] ?? "";
    if (!fence) {
      fence = { marker, length: markerRun.length };
      continue;
    }
    if (
      marker === fence.marker
      && markerRun.length >= fence.length
      && suffix.trim().length === 0
    ) {
      fence = null;
    }
  }

  if (fence) return true;

  const outsideFences = outsideFenceLines.join("\n");
  for (let index = 0; index < outsideFences.length - 1; index += 1) {
    if (outsideFences[index] !== "]" || outsideFences[index + 1] !== "(") continue;
    if (isEscapedMarkdownCharacter(outsideFences, index)) continue;

    let depth = 1;
    for (let destinationIndex = index + 2; destinationIndex < outsideFences.length; destinationIndex += 1) {
      if (isEscapedMarkdownCharacter(outsideFences, destinationIndex)) continue;
      if (outsideFences[destinationIndex] === "(") depth += 1;
      if (outsideFences[destinationIndex] === ")") depth -= 1;
      if (depth === 0) break;
    }
    if (depth > 0) return true;
  }

  return false;
}

function isEscapedMarkdownCharacter(markdown: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function hasVisibleEditorRewriteContent(slice: Slice) {
  let visible = false;
  slice.content.descendants((node) => {
    if (node.isText && Boolean(node.text?.trim())) {
      visible = true;
      return false;
    }
    if (
      (node.isLeaf && node.type.name !== "hardBreak") ||
      node.type.name === "table"
    ) {
      visible = true;
      return false;
    }
    return true;
  });
  return visible;
}

function insertEditorPreviewSlice(editor: Editor, position: number, slice: Slice) {
  const safePosition = clampNumber(position, 0, editor.state.doc.content.size);
  if (!slice.content.size) return { from: safePosition, to: safePosition };
  const transaction = markEditorRewriteTransaction(
    editor.state.tr.insert(safePosition, slice.content),
  ).setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
  return { from: safePosition, to: safePosition + slice.content.size };
}

function insertMarkdownAtPosition(editor: Editor, position: number, markdown: string) {
  const slice = buildEditorRewriteSlice(editor, markdown, []);
  if (!slice.content.size) {
    return false;
  }

  const safePosition = clampNumber(position, 0, editor.state.doc.content.size);
  const transaction = markEditorRewriteTransaction(
    editor.state.tr.insert(safePosition, slice.content),
  );
  editor.view.dispatch(transaction);
  if (!editor.state.doc.eq(transaction.doc)) {
    return false;
  }
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}

interface EditorViewportRestoreState {
  generation: number;
  observer: MutationObserver;
  timeout: number | null;
  removeScrollListeners: () => void;
}

const editorViewportRestoreStates = new WeakMap<Editor, EditorViewportRestoreState>();
function releaseEditorViewportPreservation(editor: Editor, releaseAfterMs = 0) {
  const state = editorViewportRestoreStates.get(editor);
  if (!state) return;

  const release = () => {
    if (editorViewportRestoreStates.get(editor) !== state) return;
    state.observer.disconnect();
    state.removeScrollListeners();
    if (state.timeout !== null) window.clearTimeout(state.timeout);
    editorViewportRestoreStates.delete(editor);
  };

  if (releaseAfterMs > 0) {
    if (state.timeout !== null) window.clearTimeout(state.timeout);
    state.timeout = window.setTimeout(release, releaseAfterMs);
    return;
  }

  release();
}

function preserveEditorViewport(editor: Editor, options?: { releaseAfterMs?: number }) {
  const previousGeneration = editorViewportRestoreStates.get(editor)?.generation ?? 0;
  releaseEditorViewportPreservation(editor);
  const generation = previousGeneration + 1;
  const scrollPositions: Array<{ element: HTMLElement; left: number; top: number }> = [];
  let element: HTMLElement | null = editor.view.dom;

  while (element) {
    scrollPositions.push({
      element,
      left: element.scrollLeft,
      top: element.scrollTop,
    });
    element = element.parentElement;
  }

  let windowLeft = window.scrollX;
  let windowTop = window.scrollY;
  let restoring = false;
  const restore = () => {
    if (editorViewportRestoreStates.get(editor)?.generation !== generation) {
      return;
    }
    restoring = true;
    for (const position of scrollPositions) {
      if (position.element.scrollLeft !== position.left) {
        position.element.scrollLeft = position.left;
      }
      if (position.element.scrollTop !== position.top) {
        position.element.scrollTop = position.top;
      }
    }
    if (window.scrollX !== windowLeft || window.scrollY !== windowTop) {
      window.scrollTo(windowLeft, windowTop);
    }
    queueMicrotask(() => {
      restoring = false;
    });
  };

  const scrollListenerRemovers = scrollPositions.map((position) => {
    const updatePosition = () => {
      if (restoring) return;
      position.left = position.element.scrollLeft;
      position.top = position.element.scrollTop;
    };
    position.element.addEventListener("scroll", updatePosition, { passive: true });
    return () => position.element.removeEventListener("scroll", updatePosition);
  });
  const updateWindowPosition = () => {
    if (restoring) return;
    windowLeft = window.scrollX;
    windowTop = window.scrollY;
  };
  window.addEventListener("scroll", updateWindowPosition, { passive: true });

  const mutationRoot = editor.view.dom
    .closest<HTMLElement>(".rich-editor__frame")
    ?.querySelector<HTMLElement>(".rich-editor__rewrite-widget-host")
    ?? editor.view.dom;
  const observer = new MutationObserver(restore);
  observer.observe(mutationRoot, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });

  const state: EditorViewportRestoreState = {
    generation,
    observer,
    timeout: null,
    removeScrollListeners: () => {
      for (const removeListener of scrollListenerRemovers) removeListener();
      window.removeEventListener("scroll", updateWindowPosition);
    },
  };
  editorViewportRestoreStates.set(editor, state);
  if (options?.releaseAfterMs) {
    releaseEditorViewportPreservation(editor, options.releaseAfterMs);
  }

  queueMicrotask(restore);
}

function wrapMarkdownAsBlockquote(markdown: string) {
  const normalized = markdown.trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const alreadyQuoted = lines
    .filter((line) => line.trim().length > 0)
    .every((line) => /^\s*>/.test(line));
  if (alreadyQuoted) {
    return normalized;
  }

  return lines
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function hasAllPlaceholderTokens(
  markdown: string,
  placeholders: readonly EditorRewritePlaceholder[],
) {
  let searchStart = 0;
  return placeholders.every((placeholder) => {
    const index = markdown.indexOf(placeholder.token, searchStart);
    if (index < 0) {
      return false;
    }
    searchStart = index + placeholder.token.length;
    return true;
  });
}

async function runFallbackClipboardWrite(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function toggleCodeBlockWithDefault(editor: Editor, defaultCodeLanguage?: string | null) {
  const language = normalizeCodeLanguage(defaultCodeLanguage);

  if (language) {
    return editor
      .chain()
      .focus()
      .toggleCodeBlock({ language, languageExplicit: false } as { language: string })
      .run();
  }

  return editor.chain().focus().toggleCodeBlock().run();
}

function applyCodeBlockLanguage(
  editor: Editor,
  activeCodeBlockPos: number,
  language: string,
) {
  const { state, view } = editor;
  let tr = state.tr;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") {
      return true;
    }

    if (pos !== activeCodeBlockPos) {
      return false;
    }

    tr = tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      language,
      params: language,
      languageExplicit: true,
    });

    return false;
  });

  if (tr.docChanged) {
    view.dispatch(tr.scrollIntoView());
  }
}

function applyPlainTextCodeBlocksLanguage(editor: Editor, language: string) {
  const normalized = normalizeCodeLanguage(language);

  if (!normalized) {
    return;
  }

  const { state, view } = editor;
  let tr = state.tr;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") {
      return true;
    }

    const currentLanguage = normalizeCodeLanguage(
      typeof node.attrs.language === "string" ? node.attrs.language : node.attrs.params,
    );

    if (currentLanguage) {
      return false;
    }

    tr = tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      language: normalized,
      params: normalized,
      languageExplicit: false,
    });

    return false;
  });

  if (tr.docChanged) {
    view.dispatch(tr.scrollIntoView());
  }
}

function createEditorRewriteWidgetPlugin(options: {
  getWidgetState: () => EditorSkillWidgetState | null;
  getProtectedRange: () => { from: number; to: number } | null;
  getCallbacks: () => {
    onAccept: () => void;
    onReject: () => void;
    onCompareDown: () => void;
    onCompareUp: () => void;
    onRetry: () => void;
    onCopyAnswer: () => void;
    onInsertAnswer: () => void;
    onPreserveViewport: () => void;
    onClose: () => void;
    onOpenAiSettings?: () => void;
  };
}) {
  let widgetRoot: Root | null = null;
  let widgetDom: HTMLDivElement | null = null;
  let widgetFrame: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const ensureWidgetDom = () => {
    if (!widgetDom) {
      widgetDom = document.createElement("div");
      widgetDom.className = "rich-editor__rewrite-widget-host";
      widgetRoot = createRoot(widgetDom);
    }

    return widgetDom;
  };

  const positionWidget = (view: EditorView) => {
    const widgetState = options.getWidgetState();
    const dom = ensureWidgetDom();
    const frame = view.dom.closest<HTMLElement>(".rich-editor__frame");

    if (!widgetState || !frame) {
      dom.style.display = "none";
      return;
    }

    if (dom.parentElement !== frame) {
      frame.appendChild(dom);
    }
    widgetFrame = frame;

    const protectedRange = options.getProtectedRange();
    const anchorFrom = clampNumber(
      protectedRange?.from ?? widgetState.anchorPos,
      0,
      view.state.doc.content.size,
    );
    const anchorTo = clampNumber(
      protectedRange?.to ?? widgetState.anchorPos,
      anchorFrom,
      view.state.doc.content.size,
    );
    const startCoords = view.coordsAtPos(anchorFrom, 1);
    const endCoords = view.coordsAtPos(anchorTo, -1);
    const frameRect = frame.getBoundingClientRect();
    const availableWidth = Math.max(280, frame.clientWidth - 24);
    const width = Math.min(560, availableWidth);
    const minLeft = frame.scrollLeft + 12;
    const maxLeft = Math.max(minLeft, frame.scrollLeft + frame.clientWidth - width - 12);
    const preferredLeft = startCoords.left - frameRect.left + frame.scrollLeft;

    dom.style.display = "block";
    dom.style.width = `${width}px`;
    dom.style.left = `${clampNumber(preferredLeft, minLeft, maxLeft)}px`;
    dom.style.top = `${endCoords.bottom - frameRect.top + frame.scrollTop + 10}px`;
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
        skillName={widgetState.skillName}
        resultMode={widgetState.resultMode}
        status={widgetState.status}
        answer={widgetState.answer}
        answerHtml={widgetState.answerHtml}
        errorMessage={widgetState.errorMessage}
        hasModifyPreview={Boolean(widgetState.modifyPreview)}
        showingOriginal={widgetState.modifyPreview?.showing === "original"}
        onAccept={options.getCallbacks().onAccept}
        onReject={options.getCallbacks().onReject}
        onCompareDown={options.getCallbacks().onCompareDown}
        onCompareUp={options.getCallbacks().onCompareUp}
        onRetry={options.getCallbacks().onRetry}
        onCopyAnswer={options.getCallbacks().onCopyAnswer}
        onInsertAnswer={options.getCallbacks().onInsertAnswer}
        onPreserveViewport={options.getCallbacks().onPreserveViewport}
        onClose={options.getCallbacks().onClose}
        onOpenAiSettings={options.getCallbacks().onOpenAiSettings}
        resolvedModel={widgetState.resolvedModel}
        resolvedProfileName={widgetState.resolvedProfileName}
        usedDefaultFallback={widgetState.usedDefaultFallback}
        contextStale={widgetState.contextStale}
        parseError={widgetState.parseError}
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
    view(view) {
      const dom = ensureWidgetDom();
      const frame = view.dom.closest<HTMLElement>(".rich-editor__frame");
      if (frame) {
        frame.appendChild(dom);
        widgetFrame = frame;
      }
      renderWidget();
      positionWidget(view);

      const reposition = () => positionWidget(view);
      window.addEventListener("resize", reposition);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(reposition);
        resizeObserver.observe(view.dom);
      }

      return {
        update(nextView) {
          renderWidget();
          positionWidget(nextView);
        },
        destroy() {
          const rootToUnmount = widgetRoot;
          window.removeEventListener("resize", reposition);
          resizeObserver?.disconnect();
          resizeObserver = null;
          widgetDom?.remove();
          widgetFrame = null;
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
  onCopyImage,
  readOnly,
  editorSkills,
  unavailableReason,
  onOpenAiSettings,
  onRunEditorSkill,
  onOpenAiPrompt,
}: {
  editor: Editor;
  imageTarget: ImageContextMenuTarget;
  onCopyImage: () => void;
  readOnly: boolean;
  editorSkills: AiSettingsSnapshot["editorSkills"];
  unavailableReason?: string | null;
  onOpenAiSettings?: () => void;
  onRunEditorSkill: (skill: AiSettingsSnapshot["editorSkills"][number]) => void;
  onOpenAiPrompt: () => void;
}) {
  const canCopyImage = Boolean(imageTarget.attrs.path || imageTarget.attrs.src);
  const canRevealPath = Boolean(imageTarget.attrs.path);
  const canEditImage = !readOnly && editor.isEditable;

  return [
    {
      key: "image-copy",
      label: "复制图片",
      icon: Copy,
      disabled: !canCopyImage,
      onSelect: onCopyImage,
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
    { type: "separator", key: "image-separator-ai" },
    {
      type: "section-label",
      key: "image-ai-skills-label",
      label: "技能",
      trailingIcon: Settings2,
      trailingLabel: "打开 AI 设置",
      trailingDisabled: !onOpenAiSettings,
      onTrailingSelect: onOpenAiSettings,
    },
    {
      type: "scroll-actions",
      key: "image-ai-skills-scroll",
      ariaLabel: "图片 AI 技能列表",
      maxVisibleItems: 3,
      actions:
        editorSkills.length > 0
          ? editorSkills.map((skill) => ({
          key: `image-ai-skill-${skill.id}`,
          label: `${skill.icon?.trim() ? `${skill.icon.trim()} ` : ""}${skill.name}`,
          icon: skill.resultMode === "answer" ? Lightbulb : Sparkles,
          disabled: Boolean(unavailableReason),
          onSelect: () => onRunEditorSkill(skill),
        }))
          : [{
              key: "image-ai-no-skills",
              label: "暂无启用技能",
              icon: MoreHorizontal,
              disabled: true,
              onSelect: () => undefined,
            }],
    },
    { type: "separator", key: "image-ai-free-prompt-separator" },
    {
      key: "image-ai-free-prompt",
      label: "使用 AI 解读",
      icon: WandSparkles,
      disabled: Boolean(unavailableReason),
      onSelect: onOpenAiPrompt,
    },
    { type: "separator", key: "image-separator-size" },
    {
      key: "image-width-small",
      label: "小图（360px）",
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
      label: "自适应宽度",
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

function resolveImageTargetPath(attrs: ImageContextMenuTarget["attrs"] | undefined) {
  const direct = attrs?.path?.trim();
  if (direct) return direct;
  const source = attrs?.src?.trim();
  if (!source) return null;
  const filePath = fileUriToPath(source);
  return filePath || null;
}

function resolveImageTargetMimeType(
  attrs: ImageContextMenuTarget["attrs"] | undefined,
  path: string,
) {
  const declared = attrs?.mimeType?.trim().toLowerCase();
  if (declared) return declared;
  const extension = path.split(/[./\\]/u).pop()?.toLowerCase();
  return ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    bmp: "image/bmp",
    gif: "image/gif",
    svg: "image/svg+xml",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function imageInterpretationFormatUnavailableReason(imageTarget: ImageContextMenuTarget) {
  const path = resolveImageTargetPath(imageTarget.attrs);
  if (!path) return "图片没有可读取的本地原图";
  const mimeType = resolveImageTargetMimeType(imageTarget.attrs, path);
  if (["image/svg+xml", "image/avif", "image/heic", "image/heif"].includes(mimeType)) {
    return `暂不支持 ${mimeType.replace("image/", "").toUpperCase()} 图片`;
  }
  if (!["image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif"].includes(mimeType)) {
    return "无法识别或不支持该图片格式";
  }
  return null;
}

function buildImageEditorContext(editor: Editor, nodePos: number) {
  const beforeBlocks: string[] = [];
  const afterBlocks: string[] = [];
  editor.state.doc.forEach((node, offset) => {
    const blockEnd = offset + node.nodeSize;
    if (offset <= nodePos && nodePos < blockEnd) return;
    const markdown = serializeContextBlock(editor, node);
    if (!markdown) return;
    if (blockEnd <= nodePos) beforeBlocks.push(markdown);
    else if (offset > nodePos) afterBlocks.push(markdown);
  });

  const before = takeCompleteContextBlocks(beforeBlocks, 2000, "before");
  const after = takeCompleteContextBlocks(afterBlocks, 2000, "after");
  return {
    beforeMarkdown: before || null,
    afterMarkdown: after || null,
  };
}

function serializeContextBlock(editor: Editor, node: Parameters<typeof serializeRichTextNodesMarkdown>[1][number]) {
  let neutralPlaceholder: string | null = null;
  node.descendants((child) => {
    if (child.type.name === "image") {
      const label = typeof child.attrs.alt === "string" && child.attrs.alt.trim()
        ? `：${child.attrs.alt.trim()}`
        : "";
      neutralPlaceholder = `[相邻图片${label}]`;
      return false;
    }
    if (child.type.name === "attachment") {
      neutralPlaceholder = "[相邻附件]";
      return false;
    }
    return neutralPlaceholder === null;
  });
  return neutralPlaceholder ?? serializeRichTextNodesMarkdown(editor, [node]);
}

function takeCompleteContextBlocks(
  blocks: readonly string[],
  budget: number,
  direction: "before" | "after",
) {
  const selected: string[] = [];
  const candidates = direction === "before" ? [...blocks].reverse() : [...blocks];
  let length = 0;
  for (const block of candidates) {
    const addition = block.length + (selected.length > 0 ? 2 : 0);
    if (length + addition > budget) break;
    selected.push(block);
    length += addition;
  }
  if (direction === "before") selected.reverse();
  return selected.join("\n\n");
}

async function copyImageToClipboard(
  editor: Editor,
  imageTarget: ImageContextMenuTarget,
) {
  const source = await resolveImageClipboardSource(imageTarget.attrs);
  const parsed = source ? parseDataUrl(source) : null;

  if (
    parsed?.mimeType.startsWith("image/") &&
    typeof ClipboardItem !== "undefined" &&
    navigator.clipboard?.write
  ) {
    try {
      const imageBlob = new Blob([parsed.bytes], { type: parsed.mimeType });
      const alt = imageTarget.attrs.alt?.trim() || imageTarget.attrs.title?.trim() || "图片";
      const escapedAlt = escapeClipboardHtmlAttribute(alt);
      const html = `<img src="${source}" alt="${escapedAlt}">`;

      await navigator.clipboard.write([
        new ClipboardItem({
          [parsed.mimeType]: imageBlob,
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([alt], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {
      // Fall back to the editor's native copy path below.
    }
  }

  try {
    await runEditorClipboardCommand(editor, "copy");
    return true;
  } catch {
    return false;
  }
}

async function resolveImageClipboardSource(attrs: ImageContextMenuTarget["attrs"]) {
  if (attrs.path) {
    try {
      return await desktopApi.readFileAsDataUrl(attrs.path, attrs.mimeType);
    } catch {
      // Fall through to the source stored on the image node.
    }
  }

  return attrs.src?.startsWith("data:") ? attrs.src : null;
}

function escapeClipboardHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildAttachmentContextMenuActions({
  editor,
  attachmentTarget,
  readOnly,
}: {
  editor: Editor;
  attachmentTarget: AttachmentContextMenuTarget;
  readOnly: boolean;
}) {
  const attrs = attachmentTarget.attrs;
  const canOpen = Boolean(attrs.path || attrs.href);
  const canReveal = Boolean(attrs.path);
  const canUpdateDocument = !readOnly && editor.isEditable && Boolean(attrs.documentId);

  return [
    {
      key: "attachment-open",
      label: "打开文件",
      icon: ExternalLink,
      disabled: !canOpen,
      onSelect: () => {
        void openAttachmentAsset({ kind: "file", ...attrs, title: attrs.title ?? "未命名文件" });
      },
    },
    {
      key: "attachment-reveal",
      label: "打开文件所在位置",
      icon: FolderOpen,
      disabled: !canReveal,
      onSelect: () => {
        if (attrs.path) {
          void desktopApi.revealPath(attrs.path).catch(() => {
            // The caller owns error presentation.
          });
        }
      },
    },
    { type: "separator", key: "attachment-separator-document" },
    {
      key: "attachment-rename",
      label: "重命名",
      icon: Pencil,
      disabled: !canUpdateDocument,
      onSelect: () => {
        void renameAttachmentDocument(editor, attachmentTarget);
      },
    },
    {
      key: "attachment-star",
      label: attrs.isStarred ? "取消标星" : "标星",
      icon: Star,
      disabled: !canUpdateDocument,
      onSelect: () => {
        void toggleAttachmentStar(editor, attachmentTarget);
      },
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

function syncDomTextSelectionToEditor(editor: Editor, anchorPos: number | null) {
  const domSelection = readDomTextSelection(editor);
  if (
    !domSelection ||
    (anchorPos !== null &&
      (anchorPos < domSelection.from || anchorPos > domSelection.to))
  ) {
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
    anchorPos: number | null;
  },
) {
  if (!storedSelection) {
    return false;
  }

  const anchorPos = options.anchorPos;

  if (anchorPos === null) {
    return false;
  }

  if (anchorPos < storedSelection.from || anchorPos > storedSelection.to) {
    return false;
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

function isPosWithinSelection(editor: Editor, pos: number) {
  const { from, to } = editor.state.selection;
  return from !== to && pos >= from && pos <= to;
}

function setContextMenuInsertionTarget(editor: Editor, pos: number) {
  try {
    const selection = TextSelection.near(editor.state.doc.resolve(pos), 1);
    editor.view.dispatch(
      editor.state.tr
        .setSelection(selection)
        .setMeta("addToHistory", false),
    );
  } catch {
    // Keep the current selection when the click cannot be mapped safely.
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

function resolveAttachmentContextMenuTarget(
  editor: Editor,
  target: Element | null,
  eventPath: EventTarget[] = [],
): AttachmentContextMenuTarget | null {
  const attachmentElement =
    findAttachmentElementFromEventPath(eventPath) ??
    target?.closest<HTMLElement>("[data-type='attachment']");

  if (!(attachmentElement instanceof HTMLElement)) {
    const selection = editor.state.selection;

    if (selection instanceof NodeSelection && selection.node.type.name === "attachment") {
      return {
        nodePos: selection.from,
        attrs: normalizeAttachmentAttrs(selection.node.attrs),
      };
    }

    return null;
  }

  const nodePos =
    findNodePos(editor.view, attachmentElement, "attachment") ??
    findAttachmentNodePosByElement(editor, attachmentElement);

  if (typeof nodePos !== "number") {
    return null;
  }

  const node = editor.state.doc.nodeAt(nodePos);

  if (!node || node.type.name !== "attachment") {
    return null;
  }

  return {
    nodePos,
    attrs: normalizeAttachmentAttrs(node.attrs),
  };
}

function findAttachmentElementFromEventPath(eventPath: EventTarget[]) {
  for (const pathTarget of eventPath) {
    if (!(pathTarget instanceof Element)) {
      continue;
    }

    const attachmentElement = pathTarget.closest<HTMLElement>("[data-type='attachment']");

    if (attachmentElement) {
      return attachmentElement;
    }
  }

  return null;
}

function findAttachmentNodePosByElement(editor: Editor, attachmentElement: HTMLElement) {
  const targetAttrs = normalizeAttachmentAttrs({
    documentId: attachmentElement.dataset.documentId,
    href: attachmentElement.dataset.href,
    isStarred: attachmentElement.dataset.isStarred,
    meta: attachmentElement.dataset.meta,
    mimeType: attachmentElement.dataset.mimeType,
    path: attachmentElement.dataset.path,
    title: attachmentElement.dataset.title,
  });
  let foundPos: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (foundPos !== null || node.type.name !== "attachment") {
      return foundPos === null;
    }

    const nodeAttrs = normalizeAttachmentAttrs(node.attrs);
    const matchesDocument =
      targetAttrs.documentId !== undefined && nodeAttrs.documentId === targetAttrs.documentId;
    const matchesPath = targetAttrs.path !== undefined && nodeAttrs.path === targetAttrs.path;
    const matchesHref = targetAttrs.href !== undefined && nodeAttrs.href === targetAttrs.href;
    const matchesTitle = targetAttrs.title !== undefined && nodeAttrs.title === targetAttrs.title;

    if (matchesDocument || matchesPath || matchesHref || matchesTitle) {
      foundPos = pos;
      return false;
    }

    return true;
  });

  return foundPos ?? undefined;
}

function normalizeAttachmentAttrs(attrs: Record<string, unknown>): AttachmentContextMenuTarget["attrs"] {
  const documentId = normalizeOptionalNumber(attrs.documentId);

  return {
    documentId,
    href: normalizeOptionalString(attrs.href),
    isStarred: attrs.isStarred === true || attrs.isStarred === "true",
    meta: normalizeOptionalString(attrs.meta),
    mimeType: normalizeOptionalString(attrs.mimeType),
    path: normalizeOptionalString(attrs.path),
    title: normalizeOptionalString(attrs.title),
  };
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
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

function resolveActiveTableElement(editor: Editor) {
  if (!editor.isActive("table")) {
    return null;
  }

  try {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const origin = node instanceof Element ? node : node.parentElement;

    if (!origin) {
      return null;
    }

    return origin.closest<HTMLElement>(".tableWrapper, .rich-editor__table-node, table");
  } catch {
    return null;
  }
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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
  selectNodeAtPos(editor, nodePos, "image");
}

function selectNodeAtPos(editor: Editor, nodePos: number, expectedType?: string) {
  const { doc, tr } = editor.state;
  const node = doc.nodeAt(nodePos);

  if (!node || (expectedType && node.type.name !== expectedType)) {
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

function updateAttachmentNodeAttrs(
  editor: Editor,
  nodePos: number,
  attrs: Partial<AttachmentContextMenuTarget["attrs"]>,
) {
  const node = editor.state.doc.nodeAt(nodePos);

  if (!node || node.type.name !== "attachment") {
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

async function openAttachmentAsset(asset: RichEditorAsset) {
  if (asset.path) {
    await desktopApi.openFile(asset.path);
    return;
  }

  if (asset.href && asset.href !== "#") {
    const filePath = asset.href.startsWith("file:") ? fileUriToPath(asset.href) : null;

    if (filePath) {
      await desktopApi.openFile(filePath);
      return;
    }

    window.open(asset.href, "_blank", "noopener,noreferrer");
  }
}

async function renameAttachmentDocument(
  editor: Editor,
  attachmentTarget: AttachmentContextMenuTarget,
) {
  const documentId = attachmentTarget.attrs.documentId;
  if (!documentId) {
    return;
  }

  const currentTitle = attachmentTarget.attrs.title?.trim() || "未命名文件";
  const nextTitle = window.prompt("重命名文件", currentTitle)?.trim();

  if (!nextTitle || nextTitle === currentTitle) {
    return;
  }

  const document = await projectMindApi.documentUpdateMeta({
    documentId,
    baseName: nextTitle,
  });

  updateAttachmentNodeAttrs(editor, attachmentTarget.nodePos, {
    title: document.name,
    path: document.managedPath || document.originalPath,
    href: document.managedPath || document.originalPath,
    mimeType: document.mimeType,
    meta: document.mimeType,
    isStarred: document.isStarred,
  });
}

async function toggleAttachmentStar(
  editor: Editor,
  attachmentTarget: AttachmentContextMenuTarget,
) {
  const documentId = attachmentTarget.attrs.documentId;
  if (!documentId) {
    return;
  }

  const document = await projectMindApi.documentUpdateMeta({
    documentId,
    isStarred: !attachmentTarget.attrs.isStarred,
  });

  updateAttachmentNodeAttrs(editor, attachmentTarget.nodePos, {
    isStarred: document.isStarred,
    title: document.name,
    path: document.managedPath || document.originalPath,
    href: document.managedPath || document.originalPath,
    mimeType: document.mimeType,
    meta: document.mimeType,
  });
}

async function runEditorPasteCommand(
  editor: Editor,
  options: {
    onPasteHtml?: (
      html: string,
      restoreTarget: () => boolean,
    ) => boolean | void | Promise<boolean | void>;
    onPasteImages?: (
      files: File[],
      restoreTarget: () => boolean,
    ) => boolean | void | Promise<boolean | void>;
    onFailure?: () => void;
  } = {},
) {
  const pasteTarget = captureEditorPasteTarget(editor);
  editor.commands.focus();

  if (isTauriRuntime()) {
    let formatFailures = 0;
    let fallbackText: string | null = null;

    if (options.onPasteHtml) {
      let html: string | null = null;

      try {
        html = await desktopApi.readClipboardHtml();
      } catch {
        formatFailures += 1;
      }

      if (html && (hasMeaningfulPastedHtml(html) || isImageOnlyPastedHtml(html))) {
        try {
          const inserted = await options.onPasteHtml(html, pasteTarget.restore);
          if (inserted !== false) {
            pasteTarget.release();
            return;
          }
          if (!pasteTarget.isActive()) {
            options.onFailure?.();
            return;
          }
          formatFailures += 1;
        } catch {
          if (!pasteTarget.isActive()) {
            options.onFailure?.();
            return;
          }
          formatFailures += 1;
        }
      }
    }

    try {
      const text = await desktopApi.readClipboardText();

      if (text) {
        fallbackText = text;
      }
    } catch {
      formatFailures += 1;
      // Non-text clipboard contents are handled below.
    }

    if (options.onPasteImages) {
      try {
        const image = await desktopApi.readClipboardImage();

        if (image) {
          const file = await clipboardRgbaToPngFile(image);
          const inserted = await options.onPasteImages([file], pasteTarget.restore);
          if (inserted !== false) {
            pasteTarget.release();
            return;
          }
          if (!pasteTarget.isActive()) {
            options.onFailure?.();
            return;
          }
          formatFailures += 1;
        }
      } catch {
        if (!pasteTarget.isActive()) {
          options.onFailure?.();
          return;
        }
        formatFailures += 1;
      }
    }

    if (fallbackText) {
      if (!pasteTarget.restore()) {
        options.onFailure?.();
        return;
      }
      pastePlainClipboardText(editor, fallbackText);
      return;
    }

    if (formatFailures > 0) {
      options.onFailure?.();
    }
    pasteTarget.release();
    return;
  }

  try {
    const text = await navigator.clipboard?.readText?.();

    if (text) {
      if (!pasteTarget.restore()) {
        options.onFailure?.();
        return;
      }
      pastePlainClipboardText(editor, text);
    }
  } catch {
    // Browser clipboard permissions vary; desktop builds use the native bridge above.
  } finally {
    pasteTarget.release();
  }
}

function captureEditorPasteTarget(editor: Editor) {
  const initialSelection = editor.state.selection;
  const bookmark = initialSelection.getBookmark();
  const mapping = new Mapping();
  let active = true;

  const handleTransaction = ({ transaction }: { transaction: Editor["state"]["tr"] }) => {
    if (active) {
      mapping.appendMapping(transaction.mapping);
    }
  };
  const release = () => {
    if (!active) {
      return;
    }

    active = false;
    editor.off("transaction", handleTransaction);
  };
  const restore = () => {
    if (!active) {
      return false;
    }

    release();
    const mappedFrom = mapping.mapResult(initialSelection.from, 1);
    const mappedTo = mapping.mapResult(initialSelection.to, -1);

    if (mappedFrom.deletedAcross || mappedTo.deletedAcross) {
      return false;
    }

    try {
      const selection = bookmark.map(mapping).resolve(editor.state.doc);
      editor.view.dispatch(
        editor.state.tr
          .setSelection(selection)
          .setMeta("addToHistory", false),
      );
      editor.view.focus();
      return true;
    } catch {
      return false;
    }
  };

  editor.on("transaction", handleTransaction);

  return {
    isActive: () => active,
    release,
    restore,
  };
}

function pastePlainClipboardText(editor: Editor, text: string) {
  if (shouldHandlePastedMarkdown(text)) {
    editor.view.pasteHTML(renderMarkdownToHtml(text), createSyntheticPasteEvent());
    return;
  }

  editor.view.pasteText(text, createSyntheticPasteEvent());
}

async function clipboardRgbaToPngFile(image: {
  rgba: Uint8Array;
  width: number;
  height: number;
}) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("无法转换剪贴板图片");
  }

  context.putImageData(
    new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
    0,
    0,
  );
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
      } else {
        reject(new Error("无法编码剪贴板图片"));
      }
    }, "image/png");
  });

  return new File([blob], "clipboard-image.png", { type: "image/png" });
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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

  const payload = await buildRichTextClipboardPayloadAsync(
    editor.state.selection.content(),
    editor.view,
  );

  if (!payload) {
    return;
  }

  try {
    if (
      typeof ClipboardItem !== "undefined" &&
      navigator.clipboard?.write
    ) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
          "text/html": new Blob([payload.html], { type: "text/html" }),
        }),
      ]);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload.text);
    }
  } catch {
    // Clipboard permissions vary by webview/browser; fail silently.
  }

  if (command === "cut" && editor.isEditable) {
    editor.view.dispatch(editor.state.tr.deleteSelection().scrollIntoView());
  }
}

function serializeRichTextClipboard(content: Slice, view: EditorView) {
  const payload = buildRichTextClipboardPayload(content, view);
  return payload?.text ?? content.content.textBetween(0, content.content.size, "\n");
}

async function writeRichTextClipboardPayloadAsync(payload: { html: string; text: string }) {
  if (
    typeof ClipboardItem === "undefined" ||
    !navigator.clipboard?.write
  ) {
    return false;
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": new Blob([payload.text], { type: "text/plain" }),
      "text/html": new Blob([payload.html], { type: "text/html" }),
    }),
  ]);
  return true;
}

async function buildRichTextClipboardPayloadAsync(content: Slice, view: EditorView) {
  if (typeof document === "undefined") {
    const text = content.content.textBetween(0, content.content.size, "\n");
    return text ? { html: text, text } : null;
  }

  const serializer = DOMSerializer.fromSchema(view.state.schema);
  const container = document.createElement("div");

  container.appendChild(serializer.serializeFragment(content.content, { document }));
  await inlineClipboardImageSourcesAsync(container, view);

  const html = container.innerHTML;
  const text = richTextHtmlToPlainText(html, {
    preserveStructure: true,
  });

  if (!html && !text) {
    return null;
  }

  return { html, text };
}

function buildRichTextClipboardPayload(content: Slice, view: EditorView) {
  if (typeof document === "undefined") {
    const text = content.content.textBetween(0, content.content.size, "\n");
    return text ? { html: text, text } : null;
  }

  const serializer = DOMSerializer.fromSchema(view.state.schema);
  const container = document.createElement("div");

  container.appendChild(serializer.serializeFragment(content.content, { document }));
  inlineClipboardImageSources(container, view);

  const html = container.innerHTML;
  const text = richTextHtmlToPlainText(html, {
    preserveStructure: true,
  });

  if (!html && !text) {
    return null;
  }

  return { html, text };
}

function inlineClipboardImageSources(container: HTMLElement, view: EditorView) {
  const liveImages = Array.from(
    view.dom.querySelectorAll<HTMLImageElement>("img.rich-editor__image, img"),
  );
  const imageBuckets = new Map<string, HTMLImageElement[]>();

  for (const image of liveImages) {
    const key = buildClipboardImageLookupKey(
      image.getAttribute("data-path"),
      image.getAttribute("src"),
    );

    if (!key) {
      continue;
    }

    const bucket = imageBuckets.get(key) ?? [];
    bucket.push(image);
    imageBuckets.set(key, bucket);
  }

  container.querySelectorAll("img").forEach((image) => {
    const key = buildClipboardImageLookupKey(
      image.getAttribute("data-path"),
      image.getAttribute("src"),
    );
    const liveImage = key ? imageBuckets.get(key)?.shift() : undefined;
    const nextSrc = resolveClipboardImageSrc(image, liveImage);

    if (nextSrc) {
      image.setAttribute("src", nextSrc);
    }
  });
}

async function inlineClipboardImageSourcesAsync(container: HTMLElement, view: EditorView) {
  const liveImages = Array.from(
    view.dom.querySelectorAll<HTMLImageElement>("img.rich-editor__image, img"),
  );
  const imageBuckets = new Map<string, HTMLImageElement[]>();

  for (const image of liveImages) {
    const key = buildClipboardImageLookupKey(
      image.getAttribute("data-path"),
      image.getAttribute("src"),
    );

    if (!key) {
      continue;
    }

    const bucket = imageBuckets.get(key) ?? [];
    bucket.push(image);
    imageBuckets.set(key, bucket);
  }

  const images = Array.from(container.querySelectorAll("img"));

  await Promise.all(images.map(async (image) => {
    const key = buildClipboardImageLookupKey(
      image.getAttribute("data-path"),
      image.getAttribute("src"),
    );
    const liveImage = key ? imageBuckets.get(key)?.shift() : undefined;
    const nextSrc = await resolveClipboardImageSrcAsync(image, liveImage);

    if (nextSrc) {
      image.setAttribute("src", nextSrc);
    }
  }));
}

function buildClipboardImageLookupKey(path?: string | null, src?: string | null) {
  const normalizedPath = path?.trim();

  if (normalizedPath) {
    return `path:${normalizedPath}`;
  }

  const normalizedSrc = src?.trim();
  return normalizedSrc ? `src:${normalizedSrc}` : null;
}

function resolveClipboardImageSrc(image: Element, liveImage?: HTMLImageElement) {
  const currentSrc = image.getAttribute("src")?.trim() ?? "";

  if (currentSrc.startsWith("data:")) {
    return currentSrc;
  }

  const cachedSrc = liveImage?.dataset.clipboardSrc?.trim();

  if (cachedSrc) {
    return cachedSrc;
  }

  const inlinedSrc = liveImage ? renderImageElementAsDataUrl(liveImage) : null;

  if (inlinedSrc) {
    return inlinedSrc;
  }

  return currentSrc;
}

async function resolveClipboardImageSrcAsync(
  image: Element,
  liveImage?: HTMLImageElement,
) {
  const currentSrc = image.getAttribute("src")?.trim() ?? "";

  if (currentSrc.startsWith("data:")) {
    return currentSrc;
  }

  const cachedSrc = liveImage?.dataset.clipboardSrc?.trim();

  if (cachedSrc) {
    return cachedSrc;
  }

  const path = image.getAttribute("data-path")?.trim() ?? liveImage?.getAttribute("data-path")?.trim() ?? "";
  const mimeType =
    image.getAttribute("data-mime-type")?.trim() ??
    liveImage?.getAttribute("data-mime-type")?.trim() ??
    undefined;

  if (path) {
    try {
      return await desktopApi.readFileAsDataUrl(path, mimeType);
    } catch {
      // Fall through to a best-effort inline export below.
    }
  }

  const inlinedSrc = liveImage ? renderImageElementAsDataUrl(liveImage) : null;

  if (inlinedSrc) {
    return inlinedSrc;
  }

  return currentSrc;
}

function renderImageElementAsDataUrl(image: HTMLImageElement) {
  const width = Math.max(1, Math.round(image.naturalWidth || image.width || image.clientWidth));
  const height = Math.max(1, Math.round(image.naturalHeight || image.height || image.clientHeight));

  if (!width || !height) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  try {
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL(inferClipboardImageMimeType(image));
  } catch {
    return null;
  }
}

function inferClipboardImageMimeType(image: HTMLImageElement) {
  const mimeType = image.getAttribute("data-mime-type")?.trim().toLowerCase();

  if (mimeType === "image/jpeg" || mimeType === "image/webp") {
    return mimeType;
  }

  return "image/png";
}

function handleEditorClipboardEvent(
  view: EditorView,
  event: Event,
  command: "copy" | "cut",
  readOnly: boolean,
) {
  const clipboardEvent = event as ClipboardEvent;
  const content = view.state.selection.content();
  const payload = buildRichTextClipboardPayload(content, view);

  if (!payload || !clipboardEvent.clipboardData) {
    return false;
  }

  clipboardEvent.preventDefault();
  clipboardEvent.clipboardData.setData("text/plain", payload.text);
  clipboardEvent.clipboardData.setData("text/html", payload.html);

  if (payload.html.includes("<img")) {
    void buildRichTextClipboardPayloadAsync(content, view)
      .then(async (upgradedPayload) => {
        if (
          !upgradedPayload ||
          (upgradedPayload.html === payload.html && upgradedPayload.text === payload.text)
        ) {
          return;
        }

        await writeRichTextClipboardPayloadAsync(upgradedPayload);
      })
      .catch(() => {
        // Async clipboard upgrades are best-effort only.
      });
  }

  if (command === "cut" && !readOnly) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  }

  return true;
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

    return null;
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
      return null;
    }
  }

  return null;
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

  if (normalizedSrc.startsWith("blob:")) {
    return null;
  }

  const fallbackSrc = resolveRichTextImageSrc(asset.path, asset.src);

  if (fallbackSrc) {
    return fallbackSrc;
  }

  if (normalizedSrc.startsWith("data:")) {
    return normalizedSrc;
  }

  if (file) {
    try {
      return await readFileAsDataUrl(file);
    } catch {
      // Fall through to any existing src below.
    }
  }

  return null;
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

function hasMeaningfulPastedHtml(rawHtml: string) {
  if (!rawHtml.trim() || typeof DOMParser === "undefined") {
    return false;
  }

  const sanitizedHtml = sanitizePastedHtml(rawHtml);
  const doc = new DOMParser().parseFromString(sanitizedHtml, "text/html");

  return Boolean(
    doc.body.textContent?.trim() ||
      doc.body.querySelector(
        "table, hr, blockquote, pre, ul, ol, h1, h2, h3, h4, h5, h6",
      ),
  );
}

function isImageOnlyPastedHtml(rawHtml: string) {
  if (!rawHtml.trim() || typeof DOMParser === "undefined") {
    return false;
  }

  const doc = new DOMParser().parseFromString(sanitizePastedHtml(rawHtml), "text/html");
  return Boolean(doc.body.querySelector("img")) && !hasMeaningfulPastedHtml(rawHtml);
}

function buildImageFreePastedHtmlFallback(rawHtml: string) {
  if (!rawHtml.trim() || typeof DOMParser === "undefined") {
    return null;
  }

  const doc = new DOMParser().parseFromString(sanitizePastedHtml(rawHtml), "text/html");
  doc.body.querySelectorAll("img").forEach((image) => image.remove());

  if (!doc.body.textContent?.trim() && !doc.body.querySelector("table, hr")) {
    return null;
  }

  return doc.body.innerHTML.trim();
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

  for (const [index, image] of images.entries()) {
    let replacement: Element | null = null;

    try {
      replacement = await buildPastedImageElement(doc, image, index, assetHandlers);
    } catch {
      // Preserve the safe non-image portion of mixed clipboard HTML.
    }

    if (replacement) {
      image.replaceWith(replacement);
    } else {
      image.remove();
    }
  }

  if (!doc.body.textContent?.trim() && !doc.body.querySelector("img, table, hr")) {
    return null;
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
      return null;
    }
  }

  return null;
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
