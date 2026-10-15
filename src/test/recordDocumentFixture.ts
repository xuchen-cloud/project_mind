import type { JSONContent } from "@tiptap/core";
import type { RecordBodySaveInput, RecordEditorSaveResult, RecordEditorState, RecordTarget } from "../lib/record-document-types";
import type { NoteRecord, WorkspaceRecord } from "../lib/types";

export function fixtureDocument(value: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "1".repeat(32) },
    ...(value ? { content: [{ type: "text", text: value }] } : {}) },
    ...(value.includes("[managed image]") ? [{ type: "image", attrs: { blockId: "2".repeat(32), src: "data:image/png;base64,AA==" } }] : [])] };
}

export function fixtureEditorState(target: RecordTarget, record: NoteRecord | WorkspaceRecord, revision = 1): RecordEditorState {
  return { record,
    metadata: { title: record.title ?? null, tagIds: (record.tags ?? []).map((tag) => tag.id), revision: `metadata-${revision}`, updatedAt: record.updatedAt },
    head: { target, headRevision: revision, editSessionId: null, checkpointDueAt: null,
      projection: { schemaVersion: 1, document: fixtureDocument(record.contentMarkdown), html: record.contentHtml,
        markdown: record.contentMarkdown, text: record.contentMarkdown, bodyHash: "sha256:fixture", codeLanguage: record.defaultCodeLanguage ?? null } } };
}

/** A fixture database accepts canonical input and exposes a storage-write seam
 * for delayed writes. It never invokes the application's legacy upsert API. */
export async function fixtureBodySave(input: RecordBodySaveInput, previous: NoteRecord | WorkspaceRecord,
  persist: (fields: { noteId: number; title: string | null; tagIds: number[]; html: string; markdown: string; defaultCodeLanguage: string | null }) => Promise<NoteRecord | WorkspaceRecord>): Promise<RecordEditorSaveResult> {
  const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join("");
  const markdown = text(input.document);
  const image = input.document.content?.find((node) => node.type === "image");
  const html = `<p>${markdown}${image ? `<img src="${image.attrs?.src}">` : ""}</p>`;
  const record = await persist({ noteId: input.target.recordId, title: input.metadata?.title ?? previous.title ?? null,
    tagIds: input.metadata?.tagIds ?? (previous.tags ?? []).map((tag) => tag.id), html, markdown, defaultCodeLanguage: input.codeLanguage });
  const editor = fixtureEditorState(input.target, record, input.baseRevision + 1);
  return { editor, commit: { head: { target: editor.head.target, headRevision: editor.head.headRevision, bodyHash: editor.head.projection.bodyHash }, noChange: false, beforeVersion: "v1", afterVersion: null,
    ...(input.metadata ? { metadata: editor.metadata } : {}) } };
}
