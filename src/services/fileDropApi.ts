import type { AgentWorkspaceBinding } from "../lib/agent-types";
import { fileEditorApi } from "./fileEditorApi";
import { desktopApi } from "./desktopApi";
import { publishFileReplacedReceipt } from "../lib/content-owner-move-events";
import { releaseContentOwnerMove } from "../lib/project-content-lifecycle";
export type NativeFileDropTarget =
  | { kind: "new"; owner: number | null; name: string }
  | { kind: "update"; documentId: number; projectId: number | null; managedPath: string; expectedVersionNumber: number };
export interface FileDropInput { sourcePath: string; target: NativeFileDropTarget }
export interface FileDropResult { documentId: number; versionNumber: number; contentHash: string; noChange: boolean; oldSessionsClosed: boolean; cleanupWarning: string | null }
export type FileDropOutcome = { sourcePath: string; releaseError?: unknown } & (
  | { status: "success"; result: FileDropResult }
  | { status: "error"; error: unknown; uncertain: boolean }
);
/** Owns request and intent identity across uncertain IPC responses. Never handles source cleanup. */
export function createFileDropBatch(binding: AgentWorkspaceBinding, inputs: FileDropInput[]) {
  const frozenBinding = { ...binding };
  const entries = inputs.map(input => ({ input: { ...input, target: { ...input.target } }, requestId: crypto.randomUUID(),
    intentId: undefined as string | undefined, releasePending: false, outcome: undefined as FileDropOutcome | undefined }));
  let flight: Promise<FileDropOutcome[]> | undefined;
  return { run(): Promise<FileDropOutcome[]> {
    if (flight) return flight;
    flight = (async () => {
      for (const entry of entries) {
        const { sourcePath, target } = entry.input;
        const object = target.kind === "update" ? { workspaceId: frozenBinding.workspaceId, kind: "file" as const,
          id: String(target.documentId), scope: target.projectId === null ? { kind: "workspace" as const } : { kind: "project" as const, projectId: target.projectId } } : null;
        const terminal = entry.outcome && (entry.outcome.status === "success" || !entry.outcome.uncertain);
        try {
          if (terminal) continue;
          const capture = async () => {
            if (object) { entry.releasePending = true; await fileEditorApi.flush(frozenBinding, object, entry.requestId); }
          };
          const commit = () => desktopApi.fileCommand<FileDropResult>("file_drop_commit", {
            binding: frozenBinding, requestId: entry.requestId, intentId: entry.intentId,
          });
          let result: FileDropResult;
          if (entry.intentId) {
            // A lost response may be a completed replacement. Confirm its receipt
            // before touching an editor that could already contain newer input.
            try { result = await commit(); }
            catch (error) {
              if (!object || !error || typeof error !== "object" || !("code" in error) || error.code !== "EDITOR_BUSY") throw error;
              await capture();
              result = await commit();
            }
          } else {
            // G14 seal spans capture, prepare and commit. Keep the displayed CAS.
            await capture();
            const prepared = await desktopApi.fileCommand<{ intentId: string }>("file_drop_prepare", {
              binding: frozenBinding, requestId: entry.requestId, sourcePath, target,
            });
            entry.intentId = prepared.intentId;
            result = await commit();
          }
          entry.outcome = { sourcePath, status: "success", result };
          if (object) publishFileReplacedReceipt({ binding: frozenBinding, operationId: entry.requestId, object,
            versionNumber: result.versionNumber, contentHash: result.contentHash, noChange: result.noChange, oldSessionsClosed: result.oldSessionsClosed });
        } catch (error) {
          entry.outcome = { sourcePath, status: "error", error,
            uncertain: !(error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code !== "RUNTIME_INCOMPATIBLE") };
        } finally {
          if (object) {
            try {
              if (entry.releasePending) {
                await fileEditorApi.release(frozenBinding, object, entry.requestId);
                entry.releasePending = false;
              }
              // A retry can confirm failure after the original release was acknowledged.
              if (entry.outcome?.status === "error" && !entry.outcome.uncertain) {
                releaseContentOwnerMove({ binding: frozenBinding, operationId: entry.requestId, source: object });
              }
              delete entry.outcome!.releaseError;
            } catch (releaseError) { entry.outcome!.releaseError = releaseError; }
          }
        }
      }
      return entries.map(entry => entry.outcome!);
    })().finally(() => { flight = undefined; });
    return flight;
  } };
}
