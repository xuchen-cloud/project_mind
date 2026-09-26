import type { WorkspaceRecord, WorkspaceRecordUpsertInput } from "./types";

export function buildWorkspaceRecordRenameInput(
  record: WorkspaceRecord,
  title: string,
): WorkspaceRecordUpsertInput {
  return {
    noteId: record.id,
    title: title.trim() || undefined,
    markdown: record.contentMarkdown,
    html: record.contentHtml,
    defaultCodeLanguage: record.defaultCodeLanguage ?? null,
    tagIds: (record.tags ?? []).map((tag) => tag.id),
  };
}
