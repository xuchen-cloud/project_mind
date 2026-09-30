import { isAiCapabilityConfigured } from "./ai";
import { enqueueAndWait, readRecordMetadataJobResult } from "./aiJobs";
import { buildRecordAiMetadataJobInput } from "./recordAiMetadata";
import { colorKeyForTagLabel, mergeUniqueTagIds } from "./tags";
import type { AiSettingsSnapshot, NoteRecord, ProjectTagRecord, WorkspaceRecord } from "./types";
import { recordDocumentApi } from "../services/recordDocumentApi";
import type { AgentWorkspaceBinding } from "./agent-types";
import type { RecordTarget } from "./record-document-types";

const pending = new Map<string, { cancelled: boolean }>();
export function cancelAllQuickNoteRecordMetadata() {
  for (const operation of pending.values()) operation.cancelled = true;
}

export function cancelQuickNoteRecordMetadata(recordId: number, projectId?: number) {
  const operation = pending.get(`${projectId ?? "workspace"}:${recordId}`);
  if (operation) operation.cancelled = true;
}

export async function completeQuickNoteRecordMetadata({ record, projectId, availableTags, aiSettings, binding }: {
  record: NoteRecord | WorkspaceRecord;
  binding: AgentWorkspaceBinding;
  projectId?: number;
  availableTags: ProjectTagRecord[];
  aiSettings: AiSettingsSnapshot | null;
}) {
  if (!aiSettings || !(aiSettings.hasUsableDefault || isAiCapabilityConfigured(aiSettings, "default"))) return;
  const key = `${projectId ?? "workspace"}:${record.id}`;
  const operation = { cancelled: false };
  const previous = pending.get(key);
  if (previous) previous.cancelled = true;
  pending.set(key, operation);
  try {
  const target: RecordTarget = { scope: projectId === undefined ? { kind: "workspace" } : { kind: "project", projectId }, recordId: record.id };
  const baseline = await recordDocumentApi.metadataGet(binding,target);
  if (operation.cancelled || baseline.title !== (record.title ?? null)
    || JSON.stringify([...baseline.tagIds].sort((a,b) => a-b)) !== JSON.stringify((record.tags ?? []).map((tag) => tag.id).sort((a,b) => a-b))) return;
  const job = await enqueueAndWait(buildRecordAiMetadataJobInput({
    targetKey: `quick-note-metadata:${projectId ?? "workspace"}:${record.id}`,
    markdown: record.contentMarkdown,
    availableTags,
  }));
  if (operation.cancelled) return;
  if (job.status !== "succeeded") throw new Error(job.errorMessage || "AI 元信息填写未完成");
  const suggestion = readRecordMetadataJobResult(job);
  return await recordDocumentApi.metadataApply(binding,{
    metadata: { target, title: suggestion.title, expectedRevision: baseline.revision,
      tagIds: mergeUniqueTagIds(baseline.tagIds,suggestion.existingTagIds) },
    newTags: suggestion.newTags.map((label) => ({ label,colorKey: colorKeyForTagLabel(label) })),
  },crypto.randomUUID());
  } finally { if (pending.get(key) === operation) pending.delete(key); }
}
