import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  Bold,
  Code2,
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
  Pilcrow,
  Quote,
  Strikethrough,
  Table2,
} from "lucide-react";

import { desktopApi } from "../../services/desktopApi";
import { ToolbarButton } from "../../ui/components";
import { buildRichEditorExtensions } from "./extensions";
import { serializeEditorMarkdown } from "./markdown";
import type {
  RichEditorAsset,
  RichEditorAssetHandlers,
  RichEditorPersistState,
  RichEditorValue,
  RichEditorVariant,
} from "./types";

const EMPTY_HTML = "<p></p>";
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "avif"];

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

      const snapshot = serializeEditor(editor);

      if (snapshot.html === lastPersistedHtmlRef.current) {
        updatePersistState(snapshot.html === EMPTY_HTML ? "idle" : "saved");
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
        updatePersistState(snapshot.html === EMPTY_HTML ? "idle" : "saved");
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

    updatePersistState(nextHtml === EMPTY_HTML ? "idle" : "saved");
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

  const insertTable = useCallback(() => {
    if (!editor) {
      return;
    }

    editor
      .chain()
      .focus()
      .command(ensureInsertionCursor)
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
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
        {
          key: "table",
          label: "表格",
          icon: Table2,
          isActive: () => editor.isActive("table"),
          isDisabled: editorDisabled,
          run: insertTable,
        },
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
  }, [assetBusy, assetHandlers?.insertFile, assetHandlers?.insertImage, editor, handleInsertFile, handleInsertImage, insertTable, readOnly, uiTick]);

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
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <div className="rich-editor__frame" onClick={handleAssetClick}>
        <EditorContent editor={editor} onBlur={() => void handleBlur()} />
      </div>
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
  return nextHtml && nextHtml.length > 0 ? nextHtml : EMPTY_HTML;
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
