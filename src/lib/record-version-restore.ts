import type { AgentWorkspaceBinding } from "./agent-types";
import type { RecordRestoreInput, RecordTarget } from "./record-document-types";
import { recordDocumentApi } from "../services/recordDocumentApi";

/** An ambiguous response is retried with the original baseline and request identity. */
export class RecordVersionRestoreSession {
  private attempt: { binding: AgentWorkspaceBinding; input: RecordRestoreInput; requestId: string } | null = null;
  async restore(binding: AgentWorkspaceBinding, target: RecordTarget, versionId: string) {
    const previous = this.attempt;
    if (!previous || previous.binding.workspaceId !== binding.workspaceId || previous.binding.generation !== binding.generation
      || JSON.stringify(previous.input.target) !== JSON.stringify(target) || previous.input.versionId !== versionId) {
      const current = await recordDocumentApi.editorsFlush(binding, target);
      this.attempt = { binding: { ...binding }, input: { target: structuredClone(target), versionId, baseRevision: current.head.headRevision }, requestId: crypto.randomUUID() };
    }
    const attempt = this.attempt!;
    const result = await recordDocumentApi.restore(attempt.binding, attempt.input, attempt.requestId);
    this.attempt = null;
    return result;
  }
  reset() { this.attempt = null; }
}
