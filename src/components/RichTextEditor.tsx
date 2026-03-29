import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";

interface RichTextEditorProps {
  initialHtml?: string;
  onSave: (markdown: string, html: string) => void;
  saveLabel?: string;
}

const DEFAULT_TEMPLATE = `
  <h2>背景</h2>
  <p></p>
  <h2>讨论要点</h2>
  <p></p>
  <h2>初步结论</h2>
  <p></p>
  <h2>行动项</h2>
  <p></p>
`;

export function RichTextEditor({
  initialHtml,
  onSave,
  saveLabel = "保存纪要",
}: RichTextEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [2, 3],
        },
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: initialHtml || DEFAULT_TEMPLATE,
  });

  useEffect(() => {
    if (!editor) {
      return;
    }
    editor.commands.setContent(initialHtml || DEFAULT_TEMPLATE, {
      emitUpdate: false,
    });
  }, [editor, initialHtml]);

  if (!editor) {
    return <div className="editor-loading">加载编辑器中...</div>;
  }

  return (
    <div className="minutes-editor">
      <div className="editor-toolbar">
        <button
          type="button"
          className={toolbarClass(editor.isActive("bold"))}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          粗体
        </button>
        <button
          type="button"
          className={toolbarClass(editor.isActive("italic"))}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          斜体
        </button>
        <button
          type="button"
          className={toolbarClass(editor.isActive("bulletList"))}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          列表
        </button>
        <button
          type="button"
          className={toolbarClass(editor.isActive("orderedList"))}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          编号
        </button>
        <button
          type="button"
          className={toolbarClass(editor.isActive("blockquote"))}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          引用
        </button>
        <button
          type="button"
          className={toolbarClass(editor.isActive("taskList"))}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          任务
        </button>
        <button
          type="button"
          className="toolbar-button"
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        >
          表格
        </button>
        <button
          type="button"
          className="toolbar-button toolbar-save"
          onClick={() => onSave(editor.getText(), editor.getHTML())}
        >
          {saveLabel}
        </button>
      </div>
      <EditorContent editor={editor} className="editor-surface" />
    </div>
  );
}

function toolbarClass(active: boolean) {
  return active ? "toolbar-button is-active" : "toolbar-button";
}
