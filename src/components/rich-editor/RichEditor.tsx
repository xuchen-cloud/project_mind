import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
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
  Grid2X2Plus,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  LoaderCircle,
  Paperclip,
  PanelLeft,
  PanelTop,
  Pilcrow,
  Quote,
  Rows2,
  Split,
  Strikethrough,
  Table2,
  Trash2,
} from "lucide-react";

import { desktopApi } from "../../services/desktopApi";
import { PopoverPanel, ToolbarButton } from "../../ui/components";
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

type SaveReason = "debounced" | "blur" | "queued";

interface ToolbarItem {
  key: string;
  label: string;
  icon: typeof Pilcrow;
  isActive: () => boolean;
  isDisabled?: () => boolean;
  run: () => void | Promise<void>;
  busy?: boolean;
}

interface RichEditorProps {
  html?: string;
  defaultHtml?: string;
  variant?: RichEditorVariant;
  placeholder?: string;
  readOnly?: boolean;
  enableTables?: boolean;
  autosave?: boolean | { delay?: number };
  assetHandlers?: RichEditorAssetHandlers;
  onChange?: (value: RichEditorValue) => void;
  onSave?: (value: RichEditorValue) => Promise<unknown> | unknown;
  onPersistStateChange?: (state: RichEditorPersistState) => void;
  onOpenAsset?: (asset: RichEditorAsset) => void | Promise<void>;
}

export function RichEditor({
  html,
  defaultHtml,
  variant = "toolbar",
  placeholder = "输入内容，Markdown 会即时渲染为富文本。",
  readOnly = false,
  enableTables = true,
  autosave = false,
  assetHandlers,
  onChange,
  onSave,
  onPersistStateChange,
  onOpenAsset,
}: RichEditorProps) {
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [isFocused, setIsFocused] = useState(false);
  const [assetBusy, setAssetBusy] = useState<null | "image" | "file">(null);
  const [uiTick, setUiTick] = useState(0);

  const autosaveConfig = useMemo(() => {
    if (typeof autosave === "object") {
      return {
        enabled: true,
        delay: autosave.delay ?? 800,
      };
    }

    return {
      enabled: Boolean(autosave),
      delay: 800,
    };
  }, [autosave]);

  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const taskShortcutTransformRef = useRef(false);
  const lastPersistedHtmlRef = useRef(normalizeHtml(html ?? defaultHtml));
  const lastResolvedHtmlRef = useRef(normalizeHtml(html ?? defaultHtml));
  const persistStateRef = useRef<RichEditorPersistState>("idle");

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
    async (reason: SaveReason) => {
      if (!editor || !onSave || readOnly) {
        return;
      }

      clearPersistTimer();

      const snapshot = normalizeRichEditorValue(serializeEditor(editor));

      if (snapshot.html !== normalizeHtml(editor.getHTML())) {
        editor.commands.setContent(snapshot.html, {
          emitUpdate: false,
        });
      }

      if (snapshot.html === lastPersistedHtmlRef.current) {
        updatePersistState(snapshot.html === EMPTY_RICH_EDITOR_HTML ? "idle" : "saved");
        return;
      }

      if (saveInFlightRef.current) {
        saveQueuedRef.current = true;
        return;
      }

      saveInFlightRef.current = true;
      updatePersistState("saving");

      try {
        await onSave(snapshot);
        lastPersistedHtmlRef.current = snapshot.html;
        lastResolvedHtmlRef.current = snapshot.html;
        updatePersistState(snapshot.html === EMPTY_RICH_EDITOR_HTML ? "idle" : "saved");
      } catch (error) {
        updatePersistState("error");
        throw error;
      } finally {
        saveInFlightRef.current = false;

        if (saveQueuedRef.current || reason === "blur") {
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
    if (!editor || !autosaveConfig.enabled || !onSave || readOnly) {
      return;
    }

    if (persistState === "dirty") {
      schedulePersist();
    }
  }, [autosaveConfig.enabled, editor, onSave, persistState, readOnly, schedulePersist]);

  useEffect(() => {
    return () => {
      clearPersistTimer();
    };
  }, [clearPersistTimer]);

  const handleBlur = useCallback(async () => {
    if (!autosaveConfig.enabled || !onSave || readOnly) {
      return;
    }

    try {
      await persistEditor("blur");
    } catch {
      // The activity page handles error feedback with a toast.
    }
  }, [autosaveConfig.enabled, onSave, persistEditor, readOnly]);

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
      const src = asset.src ?? (asset.path ? desktopApi.toFileUrl(asset.path) : null);

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
    ];
  }, [editor, editorHasTableSelection, enableTables, readOnly, uiTick]);

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
        isFocused ? "is-focused" : "",
        readOnly ? "is-readonly" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {variant === "toolbar" ? (
        <div className="rich-editor__toolbar" aria-label="文本格式工具栏">
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

      <div className="rich-editor__frame" onClick={handleAssetClick}>
        <EditorContent editor={editor} onBlur={() => void handleBlur()} />
      </div>
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
  const nextHtml = html?.trim();
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

async function pickPath(options: {
  title: string;
  filters?: { name: string; extensions: string[] }[];
}) {
  return desktopApi.pickFile({
    title: options.title,
    filters: options.filters,
  });
}
