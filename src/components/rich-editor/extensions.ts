import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import { getSchema } from "@tiptap/core";

import { Attachment } from "./extensions/Attachment";
import { ContactMention } from "./extensions/ContactMention";
import { InternalReference } from "./extensions/InternalReference";
import { ManagedImage } from "./extensions/ManagedImage";
import { ManagedTable } from "./extensions/ManagedTable";
import { TagMention } from "./extensions/TagMention";

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
    ManagedTable.configure({
      cellMinWidth: 48,
      renderWrapper: true,
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    ManagedImage.configure({
      allowBase64: true,
      HTMLAttributes: {
        class: "rich-editor__image",
      },
    }),
    InternalReference,
    ContactMention,
    TagMention,
    Attachment,
  ];
}

export const richEditorSchema = getSchema(buildRichEditorExtensions(""));
