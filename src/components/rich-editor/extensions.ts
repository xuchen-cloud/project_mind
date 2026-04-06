import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Table } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import { getSchema } from "@tiptap/core";

import { Attachment } from "./extensions/Attachment";
import { ManagedImage } from "./extensions/ManagedImage";

export function buildRichEditorExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
    }),
    Highlight.configure({
      multicolor: false,
      HTMLAttributes: {
        class: "rich-editor__highlight",
      },
    }),
    Placeholder.configure({
      placeholder,
      emptyEditorClass: "is-editor-empty",
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
    ManagedImage.configure({
      HTMLAttributes: {
        class: "rich-editor__image",
      },
    }),
    Attachment,
  ];
}

export const richEditorSchema = getSchema(buildRichEditorExtensions(""));
