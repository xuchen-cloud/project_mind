import { isAiCapabilityConfigured } from "./ai";
import { enqueueAndWait, readRecordMetadataJobResult } from "./aiJobs";
import { buildRecordAiMetadataJobInput } from "./recordAiMetadata";
import { colorKeyForTagLabel, mergeUniqueTagIds } from "./tags";
import type { AiSettingsSnapshot, NoteRecord, ProjectTagRecord, WorkspaceRecord } from "./types";
import { projectMindApi } from "../services/projectMindApi";

const pending = new Map<string, { cancelled: boolean }>();
export function cancelAllQuickNoteRecordMetadata() {
  for (const operation of pending.values()) operation.cancelled = true;
}

export function cancelQuickNoteRecordMetadata(recordId: number, projectId?: number) {
  const operation = pending.get(`${projectId ?? "workspace"}:${recordId}`);
  if (operation) operation.cancelled = true;
}

export async function completeQuickNoteRecordMetadata({ record, projectId, availableTags, aiSettings }: {
  record: NoteRecord | WorkspaceRecord;
  projectId?: number;
  availableTags: ProjectTagRecord[];
  aiSettings: AiSettingsSnapshot | null;
}) {
  if (!aiSettings || !(aiSettings.hasUsableDefault || isAiCapabilityConfigured(aiSettings, "default"))) return;
  const key = `${projectId ?? "workspace"}:${record.id}`;
  const operation = { cancelled: false };
  pending.set(key, operation);
  try {
  const job = await enqueueAndWait(buildRecordAiMetadataJobInput({
    targetKey: `quick-note-metadata:${projectId ?? "workspace"}:${record.id}`,
    markdown: record.contentMarkdown,
    availableTags,
  }));
  if (operation.cancelled) return;
  if (job.status !== "succeeded") throw new Error(job.errorMessage || "AI 元信息填写未完成");
  const suggestion = readRecordMetadataJobResult(job);
  const input = {
    noteId: record.id,
    title: suggestion.title,
    expectedUpdatedAt: record.updatedAt,
    expectedTitle: record.title ?? undefined,
    tagIds: mergeUniqueTagIds(record.tags?.map((tag) => tag.id) ?? [], suggestion.existingTagIds),
    newTags: suggestion.newTags.map((label) => ({ label, colorKey: colorKeyForTagLabel(label) })),
  };
  return await (projectId === undefined
    ? projectMindApi.workspaceRecordMetadataApply(input)
    : projectMindApi.projectRecordMetadataApply({ ...input, projectId }));
  } finally { if (pending.get(key) === operation) pending.delete(key); }
}
