import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
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
} from "lucide-react";

import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import { repairRichTextAssetHtml, resolveRichTextImageSrc } from "../../lib/richTextAssets";
import { desktopApi } from "../../services/desktopApi";
import { ActionContextMenu, type ContextMenuAction, PopoverPanel, ToolbarButton } from "../../ui/components";
import { buildRichEditorExtensions } from "./extensions";
import { EMPTY_RICH_EDITOR_HTML, serializeEditorMarkdown } from "./markdown";
import { normalizeRichEditorValue } from "./normalize";
import type {
  RichEditorAsset,
  RichEditorAssetHandlers,
  RichEditorPersistState,
  RichEditorValue,
  RichEditorVariant,
} from "./types";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "avif"];
const TABLE_INSERT_GRID_SIZE = 6;
const DEFAULT_TABLE_DIMENSIONS = { rows: 3, cols: 3 };

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
    width?: number | null;
  };
}

interface RichEditorAutoFocusPoint {
  x: number;
  y: number;
  mode?: "viewport" | "content-relative";
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
  renderToolbarExtras?: (context: {
    persistState: RichEditorPersistState;
    save: (options?: { force?: boolean }) => Promise<unknown>;
  }) => ReactNode;
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
  renderToolbarExtras,
}: RichEditorProps) {
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [isFocused, setIsFocused] = useState(false);
  const [assetBusy, setAssetBusy] = useState<null | "image" | "file">(null);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [uiTick, setUiTick] = useState(0);

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

  const handlePastedImages = useCallback(
    async (view: EditorView, files: File[]) => {
      for (const file of files) {
        const imageAttrs = await buildPastedImageAttrs(file, assetHandlers);

        if (!imageAttrs) {
          continue;
        }

        insertImageAtSelection(view, imageAttrs);
      }
    },
    [assetHandlers?.insertImage],
  );

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
    editable: !readOnly,
    extensions: buildRichEditorExtensions(placeholder),
    content: normalizeHtml(html ?? defaultHtml),
    editorProps: {
      attributes: {
        class: "rich-editor__surface",
      },
      transformPastedHTML: (rawHtml) => sanitizePastedHtml(rawHtml),
      handlePaste: (view, event) => {
        if (readOnly) {
          return false;
        }

        const imageFiles = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );

        if (imageFiles.length === 0) {
          return false;
        }

        event.preventDefault();
        void handlePastedImages(view, imageFiles).catch(() => {
          // The caller owns error presentation.
        });
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (
          onModEnter &&
          !readOnly &&
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

        return false;
      },
    },
    onCreate: () => {
      updatePersistState("idle");
    },
    onFocus: () => {
      setIsFocused(true);
      setUiTick((tick) => tick + 1);
    },
    onBlur: () => {
      setIsFocused(false);
      setUiTick((tick) => tick + 1);
    },
    onSelectionUpdate: () => {
      setUiTick((tick) => tick + 1);
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

      if (snapshot.html !== lastPersistedHtmlRef.current) {
        updatePersistState("dirty");
      } else if (persistStateRef.current !== "saving") {
        updatePersistState("saved");
      }
    },
  });

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

    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor || readOnly || !autoFocus || autoFocusAppliedRef.current) {
      return;
    }

    autoFocusAppliedRef.current = true;

    const frame = window.requestAnimationFrame(() => {
      focusEditorForAutoFocus(editor, autoFocus);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, editor, readOnly]);

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

    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("blur", handleWindowBlur);
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

  const handleAssetClick = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
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

      try {
        await onOpenAsset({
          kind: "file",
          title,
          href,
          path,
          mimeType,
          documentId,
          meta,
        });
      } catch {
        // The caller owns error presentation.
      }
    },
    [onOpenAsset],
  );

  const editorHasTableSelection = useMemo(
    () => Boolean(editor && !readOnly && editor.isEditable && editor.isActive("table")),
    [editor, readOnly, uiTick],
  );

  const tableToolbarGroups = useMemo(() => {
    if (!enableTables || !editor || !editorHasTableSelection) {
      return [] as ToolbarItem[][];
    }
    return buildTableToolbarGroups(editor, readOnly);
  }, [editor, editorHasTableSelection, enableTables, readOnly, uiTick]);

  const handleEditorContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!editor) {
        return;
      }

      if (shouldIgnoreRichEditorContextMenuTarget(event.target)) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const hasTextSelection = syncDomTextSelectionToEditor(editor) || hasExpandedTextSelection(editor);

      if (hasTextSelection) {
        event.preventDefault();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          ariaLabel: "文本操作",
          actions: buildTextContextMenuActions(editor, readOnly),
        });
        return;
      }

      const imageTarget = resolveImageContextMenuTarget(editor, target);

      if (imageTarget) {
        selectImageNode(editor, imageTarget.nodePos);
        event.preventDefault();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          ariaLabel: "图片操作",
          actions: buildImageContextMenuActions({
            editor,
            imageTarget,
            onOpenAsset,
            readOnly,
          }),
        });
        return;
      }

      if (enableTables) {
        const tableFocusPos = resolveTableFocusPos(editor, target);

        if (typeof tableFocusPos === "number") {
          focusTableAtPos(editor, tableFocusPos);
          event.preventDefault();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            ariaLabel: "表格操作",
            actions: buildTableContextMenuActions(buildTableToolbarGroups(editor, readOnly)),
          });
          return;
        }
      }

      setContextMenu(null);
    },
    [editor, enableTables, onOpenAsset, readOnly],
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

  if (!editor) {
    return <div className="rich-editor rich-editor--loading">加载编辑器中...</div>;
  }

  return (
    <div
      className={[
        "rich-editor",
        `rich-editor--${variant}`,
        readOnly ? "is-readonly" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {variant === "toolbar" ? (
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

      {variant === "bare" && enableTables && !readOnly && isFocused ? (
        <div className="rich-editor__bare-actions">
          <TableInsertButton compact onInsert={insertTable} />
        </div>
      ) : null}

      <div className="rich-editor__frame" onClick={handleAssetClick} onContextMenu={handleEditorContextMenu}>
        <EditorContent editor={editor} onBlur={(event) => void handleBlur(event.relatedTarget)} />
      </div>
      {contextMenu ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel={contextMenu.ariaLabel}
          actions={contextMenu.actions}
          onClose={closeContextMenu}
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

function buildTextContextMenuActions(editor: Editor, readOnly: boolean) {
  const canRun = (callback: (chain: any) => { run: () => boolean }) =>
    !readOnly && editor.isEditable && callback(editor.can().chain().focus()).run();
  const runCommand = (callback: (chain: any) => { run: () => boolean }) => () => {
    callback(editor.chain().focus()).run();
  };

  return [
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
    { type: "separator", key: "text-separator-format-inline" },
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
    { type: "separator", key: "text-separator-format-block" },
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
    { type: "separator", key: "text-separator-clipboard" },
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
  ] satisfies ContextMenuAction[];
}

function buildImageContextMenuActions({
  editor,
  imageTarget,
  onOpenAsset,
  readOnly,
}: {
  editor: Editor;
  imageTarget: ImageContextMenuTarget;
  onOpenAsset?: (asset: RichEditorAsset) => void | Promise<void>;
  readOnly: boolean;
}) {
  const imageTitle = imageTarget.attrs.title?.trim() || imageTarget.attrs.alt?.trim() || "图片";
  const canOpenImage = Boolean(onOpenAsset || imageTarget.attrs.path || imageTarget.attrs.src);
  const canRevealPath = Boolean(imageTarget.attrs.path);
  const canEditImage = !readOnly && editor.isEditable;

  return [
    {
      key: "image-open",
      label: "打开图片",
      icon: ExternalLink,
      disabled: !canOpenImage,
      onSelect: () => {
        void openImageAsset({
          attrs: imageTarget.attrs,
          onOpenAsset,
          title: imageTitle,
        });
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

function syncDomTextSelectionToEditor(editor: Editor) {
  const domSelection = window.getSelection();

  if (
    !domSelection ||
    domSelection.rangeCount === 0 ||
    domSelection.isCollapsed ||
    domSelection.toString().trim().length === 0
  ) {
    return false;
  }

  const range = domSelection.getRangeAt(0);
  const { startContainer, endContainer, startOffset, endOffset } = range;

  if (
    !editor.view.dom.contains(startContainer) ||
    !editor.view.dom.contains(endContainer)
  ) {
    return false;
  }

  try {
    const start = editor.view.posAtDOM(startContainer, startOffset);
    const end = editor.view.posAtDOM(endContainer, endOffset);
    const from = Math.min(start, end);
    const to = Math.max(start, end);

    if (from === to) {
      return false;
    }

    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
    return true;
  } catch {
    return false;
  }
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
  const node = editor.state.doc.nodeAt(nodePos);

  if (!node || node.type.name !== "image") {
    return;
  }

  const tr = editor.state.tr;

  tr.setSelection(NodeSelection.create(tr.doc, nodePos));
  tr.setNodeMarkup(nodePos, undefined, {
    ...node.attrs,
    width,
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

async function openImageAsset({
  attrs,
  onOpenAsset,
  title,
}: {
  attrs: ImageContextMenuTarget["attrs"];
  onOpenAsset?: (asset: RichEditorAsset) => void | Promise<void>;
  title: string;
}) {
  if (onOpenAsset) {
    try {
      await onOpenAsset({
        kind: "image",
        title,
        path: attrs.path,
        src: attrs.src,
        mimeType: attrs.mimeType,
        documentId: attrs.documentId,
      });
      return;
    } catch {
      // Fall back to native open behavior when possible.
    }
  }

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
    const selectedText = window.getSelection()?.toString() || editor.state.doc.textBetween(
      editor.state.selection.from,
      editor.state.selection.to,
      "\n",
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
  const { from } = tr.selection;

  tr.replaceSelectionWith(imageNode, false);

  const paragraphPos = from + imageNode.nodeSize;

  tr.insert(paragraphPos, paragraphType.create());
  tr.setSelection(TextSelection.create(tr.doc, paragraphPos + 1));
  view.dispatch(tr.scrollIntoView());
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
