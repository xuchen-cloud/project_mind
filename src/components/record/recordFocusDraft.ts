import type { DocumentTagRecord } from "../../lib/types";
import type { CommittedRecordSnapshot } from "../../lib/record-save-coordinator";
import { getRenderableRichTextHtml, type RichEditorValue } from "../rich-editor";

interface RecordFocusDraftSource {
  title?: string | null;
  contentMarkdown: string;
  contentHtml: string;
  defaultCodeLanguage?: string | null;
  tags?: DocumentTagRecord[];
  updatedAt: string;
}

export function recordFocusDraftFromSnapshot(
  snapshot: Readonly<CommittedRecordSnapshot>,
): RecordFocusDraft {
  return {
    title: snapshot.title,
    content: { ...snapshot.committedContent },
    tagIds: [...snapshot.tagIds],
    codeLanguage: snapshot.defaultCodeLanguage,
    updatedAt: null,
  };
}

export interface RecordFocusDraft {
  title: string;
  content: RichEditorValue;
  tagIds: number[];
  codeLanguage: string | null;
  updatedAt: string | null;
}

export function recordFocusDraftFromRecord(
  record: RecordFocusDraftSource,
): RecordFocusDraft {
  return {
    title: record.title ?? "",
    content: {
      html: getRenderableRichTextHtml({
        html: record.contentHtml,
        markdown: record.contentMarkdown,
      }),
      text: record.contentMarkdown,
      markdown: record.contentMarkdown,
    },
    tagIds: (record.tags ?? []).map((tag) => tag.id),
    codeLanguage: record.defaultCodeLanguage ?? null,
    updatedAt: record.updatedAt,
  };
}
