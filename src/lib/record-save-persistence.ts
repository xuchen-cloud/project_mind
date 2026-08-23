import {
  buildProjectNoteImageAssetHandlers,
  buildWorkspaceNoteImageAssetHandlers,
  externalizeEmbeddedImageDataUrls,
} from "../components/rich-editor/noteImageAssets";
import { normalizeRichEditorValue } from "../components/rich-editor/normalize";
import { projectMindApi } from "../services/projectMindApi";
import type { CommittedRecordSnapshot } from "./record-save-coordinator";
import { extractTagMentionIds } from "./tagMentions";

export async function persistRecordSnapshot(
  snapshot: Readonly<CommittedRecordSnapshot>,
) {
  const assetHandlers =
    snapshot.scope === "project"
      ? buildProjectNoteImageAssetHandlers(snapshot.projectId, snapshot.activityId)
      : buildWorkspaceNoteImageAssetHandlers();
  const externalized = await externalizeEmbeddedImageDataUrls(
    snapshot.committedContent,
    assetHandlers,
  );
  const normalized = normalizeRichEditorValue(externalized);
  const mentionedTagIds = extractTagMentionIds(normalized.markdown);
  const input = {
    noteId: snapshot.recordId,
    title: snapshot.title.trim() || undefined,
    markdown: normalized.markdown,
    html: normalized.html,
    defaultCodeLanguage: snapshot.defaultCodeLanguage,
    tagIds: Array.from(new Set([...snapshot.tagIds, ...mentionedTagIds])),
  };
  const record =
    snapshot.scope === "project"
      ? await projectMindApi.projectRecordUpsert({
          ...input,
          projectId: snapshot.projectId,
          activityId: snapshot.activityId ?? undefined,
        })
      : await projectMindApi.workspaceRecordUpsert(input);
  return { updatedAt: record.updatedAt, record };
}
