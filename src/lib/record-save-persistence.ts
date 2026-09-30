import {
  buildProjectNoteImageAssetHandlers,
  buildWorkspaceNoteImageAssetHandlers,
  materializeEmbeddedRecordImages,
} from "../components/rich-editor/noteImageAssets";
import { RecordSaveFailure, type CommittedRecordSnapshot, type RecordSaveResult } from "./record-save-coordinator";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { AgentApiError } from "../services/agentApi";
import type { RecordBodySaveInput } from "./record-document-types";
import type { JSONContent } from "@tiptap/core";
import { recordMentionTagIds } from "./record-object-ids";

const canonicalDrafts = new WeakMap<object, { document: JSONContent; preparing?: Promise<void> }>();

async function persistCanonicalSnapshot(snapshot: Readonly<CommittedRecordSnapshot>): Promise<RecordSaveResult> {
  const body = snapshot.canonicalBody!;
  let draft = canonicalDrafts.get(snapshot);
  if (!draft) {
    draft = { document: structuredClone(body.document) };
    canonicalDrafts.set(snapshot, draft);
  }
  if (!draft.preparing) {
    const handlers = snapshot.scope === "project"
      ? buildProjectNoteImageAssetHandlers(snapshot.projectId) : buildWorkspaceNoteImageAssetHandlers();
    draft.preparing = materializeEmbeddedRecordImages(draft.document, handlers);
  }
  try {
    await draft.preparing;
  } catch (error) {
    draft.preparing = undefined;
    throw error;
  }
  const target = { recordId: snapshot.recordId, scope: snapshot.scope === "project"
    ? { kind: "project" as const, projectId: snapshot.projectId } : { kind: "workspace" as const } };
  const title = snapshot.title.trim() || null;
  const tagIds = Array.from(new Set([...snapshot.tagIds, ...recordMentionTagIds(draft.document)])).sort((a, b) => a - b);
  const base = body.metadataBase;
  const metadataChanged = base && (title !== base.title
    || JSON.stringify(tagIds) !== JSON.stringify([...base.tagIds].sort((a, b) => a - b)));
  const input: RecordBodySaveInput = {
    target, baseRevision: body.baseRevision, document: draft.document,
    codeLanguage: snapshot.defaultCodeLanguage, origin: body.origin, editSessionId: body.editSessionId,
    ...(metadataChanged ? { metadata: { target, expectedRevision: base.revision, title, tagIds } } : {}),
  };
  try {
    const result = await recordDocumentApi.bodySave(body.binding, input, body.requestId);
    return { updatedAt: result.editor.record.updatedAt, record: result.editor.record,
      headRevision: result.commit.head.headRevision, metadata: result.commit.metadata };
  } catch (error) {
    if (error instanceof AgentApiError) {
      const retryable = error.retryable || ["IO_FAILED", "EDITOR_BUSY", "RUNTIME_UNAVAILABLE"].includes(error.code);
      throw new RecordSaveFailure(error.message, { retryable, code: error.code, details: error.details });
    }
    throw error;
  }
}

export async function persistRecordSnapshot(
  snapshot: Readonly<CommittedRecordSnapshot>,
) {
  if (!snapshot.canonicalBody) throw new RecordSaveFailure("记录缺少正文保存基线，草稿已保留，请重新加载编辑器", { retryable: false, code: "SOURCE_NOT_READY" });
  return persistCanonicalSnapshot(snapshot);
}
