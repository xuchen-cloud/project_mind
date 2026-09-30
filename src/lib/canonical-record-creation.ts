import type { AgentScope, AgentWorkspaceBinding } from "./agent-types";
import type { RecordCreateInput, RecordEditorState } from "./record-document-types";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { buildProjectNoteImageAssetHandlers, buildWorkspaceNoteImageAssetHandlers, materializeEmbeddedRecordImages } from "../components/rich-editor/noteImageAssets";
import type { JSONContent } from "@tiptap/core";

type PreparedCreation = { binding: AgentWorkspaceBinding; input: RecordCreateInput };
type CreationAttempt = { fingerprint: string; requestId: string; prepared: Promise<PreparedCreation>; result?: RecordEditorState };

/** A failed response retains its request and asset imports until an explicit
 * reset or a change to the user's creation draft. */
export class CanonicalRecordCreation {
  private attempt: CreationAttempt | null = null;
  private running: Promise<RecordEditorState> | null = null;

  reset() {
    if (this.running) throw new Error("记录仍在保存，请稍后重试");
    this.attempt = null;
  }

  create(workspaceRoot: string, input: RecordCreateInput, expectedBinding?: AgentWorkspaceBinding): Promise<RecordEditorState> {
    const fingerprint = JSON.stringify([workspaceRoot, input, expectedBinding]);
    if (this.running) return this.attempt?.fingerprint === fingerprint ? this.running : Promise.reject(new Error("另一条记录仍在保存，请稍后重试"));
    if (this.attempt?.fingerprint !== fingerprint) {
      const captured = structuredClone(input);
      const attempt: CreationAttempt = { fingerprint, requestId: crypto.randomUUID(), prepared: this.prepare(workspaceRoot, captured, expectedBinding) };
      this.attempt = attempt;
      void attempt.prepared.catch(() => { if (this.attempt === attempt) this.attempt = null; });
    }
    const attempt = this.attempt!;
    if (attempt.result) return Promise.resolve(attempt.result);
    const running = (async () => {
      const { binding, input: prepared } = await attempt.prepared;
      const result = await recordDocumentApi.create(binding, prepared, attempt.requestId);
      attempt.result = result;
      return result;
    })();
    this.running = running;
    void running.finally(() => { if (this.running === running) this.running = null; }).catch(() => undefined);
    return running;
  }

  private async prepare(workspaceRoot: string, input: RecordCreateInput, expectedBinding?: AgentWorkspaceBinding): Promise<PreparedCreation> {
    if (!workspaceRoot) throw new Error("当前 Workspace 不可用，草稿已保留");
    const binding = await recordDocumentApi.bindingGet(workspaceRoot);
    if (expectedBinding && (binding.workspaceId !== expectedBinding.workspaceId || binding.generation !== expectedBinding.generation)) throw new Error("Workspace 已切换，草稿已保留");
    const handlers = input.scope.kind === "project" ? buildProjectNoteImageAssetHandlers(input.scope.projectId) : buildWorkspaceNoteImageAssetHandlers();
    await materializeEmbeddedRecordImages(input.document, handlers);
    const tags = new Set(input.tagIds);
    const visit = (node: JSONContent) => {
      if (node.type === "tagMention" && Number.isSafeInteger(node.attrs?.tagId) && node.attrs!.tagId > 0) tags.add(node.attrs!.tagId);
      node.content?.forEach(visit);
    };
    visit(input.document);
    return { binding, input: { ...input, tagIds: [...tags].sort((a, b) => a - b) } };
  }
}

export function createBlankCanonicalRecord(workspaceRoot: string, scope: AgentScope, session = new CanonicalRecordCreation()) {
  return session.create(workspaceRoot, {
    scope, title: null, tagIds: [], document: { type: "doc", content: [{ type: "paragraph" }] }, codeLanguage: null,
  });
}
