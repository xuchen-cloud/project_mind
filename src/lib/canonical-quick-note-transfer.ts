import type { AgentScope, AgentWorkspaceBinding } from "./agent-types";
import type { RecordEditorSaveResult, RecordQuickNoteTransferInput } from "./record-document-types";
import type { QuickNoteTransferContext, QuickNoteTransferTarget } from "./quick-note-transfer";
import type { RecordSaveCoordinator } from "./record-save-coordinator";
import { projectRecordSaveKey, workspaceRecordSaveKey } from "./record-save-coordinator";
import { requestProjectRecordFocusSave, requestWorkspaceRecordFocusSave } from "./record-focus-save";
import { mergeUniqueTagIds } from "./tags";
import { recordDocumentApi } from "../services/recordDocumentApi";

interface TransferOptions {
  workspaceRoot: string;
  scope: AgentScope;
  target: QuickNoteTransferTarget;
  markdown: string;
  title: string | null;
  resolveTagIds: () => Promise<number[]>;
  coordinator: RecordSaveCoordinator | null;
}
type Prepared = { binding: AgentWorkspaceBinding; input: RecordQuickNoteTransferInput };

/** Retain the exact submitted payload when a native response is lost. */
export class CanonicalQuickNoteTransfer {
  private attempts = new Map<string, Promise<Prepared>>();
  private bindings = new Map<string, Promise<AgentWorkspaceBinding>>();

  async bind(workspaceRoot: string, context: QuickNoteTransferContext): Promise<void> {
    await this.binding(workspaceRoot, context.requestId);
  }

  private binding(workspaceRoot: string, requestId: string) {
    let binding = this.bindings.get(requestId);
    if (!binding) {
      binding = workspaceRoot ? recordDocumentApi.bindingGet(workspaceRoot)
        : Promise.reject(new Error("当前 Workspace 不可用，草稿已保留"));
      this.bindings.set(requestId, binding);
      void binding.catch(() => { this.bindings.delete(requestId); });
    }
    return binding;
  }

  async commit(options: TransferOptions, context: QuickNoteTransferContext): Promise<RecordEditorSaveResult & { binding: AgentWorkspaceBinding }> {
    let prepared = this.attempts.get(context.requestId);
    if (!prepared) {
      prepared = this.prepare(options, context.requestId);
      this.attempts.set(context.requestId, prepared);
      void prepared.catch(() => { this.attempts.delete(context.requestId); });
    }
    const { binding, input } = await prepared;
    const result = await recordDocumentApi.quickNoteTransfer(binding, input, context.requestId);
    this.attempts.delete(context.requestId);
    this.bindings.delete(context.requestId);
    return { ...result, binding };
  }

  private async prepare(options: TransferOptions, requestId: string): Promise<Prepared> {
    const binding = await this.binding(options.workspaceRoot, requestId);
    const recordId = options.target.kind === "append" ? options.target.recordId : null;
    let baseRevision: number | null = null;
    let metadataRevision: string | null = null;
    let existingTagIds: number[] = [];
    if (recordId !== null) {
      const submitted = options.scope.kind === "project"
        ? requestProjectRecordFocusSave({ projectId: options.scope.projectId, recordId })
        : requestWorkspaceRecordFocusSave({ recordId });
      if (submitted === "failed") throw new Error("目标记录尚未保存，草稿已保留");
      const key = options.scope.kind === "project"
        ? projectRecordSaveKey(options.scope.projectId, recordId) : workspaceRecordSaveKey(recordId);
      await options.coordinator?.flush(key);
      const state = await recordDocumentApi.editorsFlush(binding, { scope: options.scope, recordId });
      baseRevision = state.head.headRevision;
      metadataRevision = state.metadata.revision;
      existingTagIds = state.metadata.tagIds;
    }
    const tagIds = mergeUniqueTagIds(existingTagIds, await options.resolveTagIds());
    return { binding, input: {
      scope: options.scope, recordId, baseRevision, metadataRevision,
      expectedMarkdown: options.markdown, title: options.title, tagIds,
    } };
  }
}
