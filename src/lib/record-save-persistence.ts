import {
  buildProjectNoteImageAssetHandlers,
  externalizeEmbeddedImageDataUrls,
} from "../components/rich-editor/noteImageAssets";
import { normalizeRichEditorValue } from "../components/rich-editor/normalize";
import { projectMindApi } from "../services/projectMindApi";
import type { CommittedProjectRecordSnapshot } from "./record-save-coordinator";
import { extractTagMentionIds } from "./tagMentions";

export async function persistProjectRecordSnapshot(
  snapshot: Readonly<CommittedProjectRecordSnapshot>,
) {
  const assetHandlers = buildProjectNoteImageAssetHandlers(
    snapshot.projectId,
    snapshot.activityId,
  );
  const externalized = await externalizeEmbeddedImageDataUrls(
    snapshot.committedContent,
    assetHandlers,
  );
  const normalized = normalizeRichEditorValue(externalized);
  const mentionedTagIds = extractTagMentionIds(normalized.markdown);
  const record = await projectMindApi.projectRecordUpsert({
    projectId: snapshot.projectId,
    activityId: snapshot.activityId ?? undefined,
    noteId: snapshot.noteId,
    title: snapshot.title.trim() || undefined,
    markdown: normalized.markdown,
    html: normalized.html,
    defaultCodeLanguage: snapshot.defaultCodeLanguage,
    tagIds: Array.from(new Set([...snapshot.tagIds, ...mentionedTagIds])),
  });
  return { updatedAt: record.updatedAt, record };
}
