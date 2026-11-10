import type { AgentScope, AgentWorkspaceBinding } from "../lib/agent-types";
import type { RecordTarget } from "../lib/record-document-types";
import { releaseContentOwnerMove, withProjectContentMove, type MovingContentObject } from "../lib/project-content-lifecycle";
import { fileOwnerScope, sameFileOwner } from "../lib/file-types";
import { invalidateInternalReferenceSearch } from "../lib/internal-reference-events";
import { AgentApiError, callAgentCommand } from "./agentApi";
import { recordDocumentApi } from "./recordDocumentApi";
import { desktopApi } from "./desktopApi";
import { ProjectFileError } from "./projectFileApi";
import { notifyProjectFilesChanged } from "../lib/project-file-navigation";
import { fileEditorApi } from "./fileEditorApi";

export interface ContentOwnerMoveInput {
  workspaceRoot: string;
  binding: AgentWorkspaceBinding;
  sourceProjectId: number | null;
  destinationProjectId: number | null;
  object: MovingContentObject;
}

interface RecordOwnerMoveResult {
  source: RecordTarget;
  target: RecordTarget;
  operationId: string;
}
interface FileOwnerMoveBaseline { expectedVersion: number; expectedWorkingRevision: number | null; expectedHash: string }
interface FileOwnerMoveResult {
  documentId: number;
  projectId: number | null;
  sourceScope: AgentScope;
  targetScope: AgentScope;
  operationId: string;
  oldSessionsClosed: boolean;
}

async function fileCommand<T>(name: string, args: Record<string, unknown>): Promise<T> {
  try { return await desktopApi.fileCommand<T>(name, args); }
  catch (failure) {
    if (failure && typeof failure === "object" && "code" in failure && "message" in failure
      && typeof failure.code === "string" && typeof failure.message === "string") {
      throw Object.assign(new ProjectFileError(failure.code, failure.message), { details: "details" in failure ? failure.details : undefined });
    }
    throw failure;
  }
}

/** A lost IPC response may follow a committed move; replay its receipt once. */
async function confirmMove<T>(submit: () => Promise<T>): Promise<T> {
  try { return await submit(); }
  catch (failure) {
    if (failure && typeof failure === "object" && "code" in failure) throw failure;
    return submit();
  }
}

export async function moveContentOwner(input: ContentOwnerMoveInput): Promise<void> {
  if (input.sourceProjectId === input.destinationProjectId) throw new Error("请选择不同的目标位置。");
  const destination = fileOwnerScope(input.destinationProjectId);
  const sourceScope = fileOwnerScope(input.sourceProjectId);
  const checkBinding = async () => {
    const current = await recordDocumentApi.bindingGet(input.workspaceRoot);
    if (current.workspaceId !== input.binding.workspaceId || current.generation !== input.binding.generation) throw new Error("工作区已切换，移动已取消。");
  };
  await checkBinding();
  const requestId = crypto.randomUUID();
  // Terminal events use requestId; a Record result's operationId is its receipt ID.
  const moveIdentity = { binding: input.binding, operationId: requestId,
    source: { workspaceId: input.binding.workspaceId, scope: sourceScope, kind: input.object.kind, id: String(input.object.id) } };
  const releaseConfirmedFailure = (failure: unknown) => {
    // A mismatched ApiResponse is not confirmation that native rejected the move.
    if ((failure instanceof AgentApiError || failure instanceof ProjectFileError) && failure.code !== "RUNTIME_INCOMPATIBLE") {
      releaseContentOwnerMove(moveIdentity);
    }
  };
  await withProjectContentMove(input.workspaceRoot, input.sourceProjectId, input.object, async () => {
    await checkBinding();
    if (input.object.kind === "record") {
      const source = { scope: sourceScope, recordId: input.object.id };
      const saved = await recordDocumentApi.editorsFlush(input.binding, source);
      if (saved.head.target.recordId !== source.recordId || !sameFileOwner(saved.head.target.scope, sourceScope)) throw new Error("保存后的记录归属已变化，请刷新核对。");
      await checkBinding();
      const args = { input: {
        binding: input.binding, requestId, data: { source, destination, headRevision: saved.head.headRevision,
          bodyHash: saved.head.projection.bodyHash, metadataRevision: saved.metadata.revision },
      } };
      const result = await confirmMove(() => callAgentCommand<RecordOwnerMoveResult>("record_owner_move", requestId, args)).catch(failure => {
        releaseConfirmedFailure(failure);
        throw failure;
      });
      if (result.source.recordId !== source.recordId || !sameFileOwner(result.source.scope, sourceScope)
        || !Number.isSafeInteger(result.target.recordId) || result.target.recordId <= 0 || !sameFileOwner(result.target.scope, destination)
        || !result.operationId) throw new Error("移动回执与请求身份不符，请核对移动结果。");
    } else {
      const object = moveIdentity.source;
      let failure: unknown;
      try {
        await fileEditorApi.flush(input.binding, object, requestId);
        const baseline = await fileCommand<FileOwnerMoveBaseline>("file_owner_move_baseline", {
          binding: input.binding, documentId: input.object.id, sourceOwner: input.sourceProjectId,
        });
        await checkBinding();
        const args = { binding: input.binding, requestId, input: {
          documentId: input.object.id, sourceOwner: input.sourceProjectId, targetOwner: input.destinationProjectId, ...baseline,
        } };
        const result = await confirmMove(() => fileCommand<FileOwnerMoveResult>("file_owner_move", args));
        if (result.documentId !== input.object.id || result.projectId !== input.destinationProjectId
          || !sameFileOwner(result.sourceScope, sourceScope) || !sameFileOwner(result.targetScope, destination)
          || result.operationId !== requestId || result.oldSessionsClosed !== true) throw new Error("移动回执与文件身份不符，请核对移动结果。");
      } catch (cause) { failure = cause; throw cause; }
      finally {
        // Native releases an uncommitted seal; a completed move is already terminal.
        await fileEditorApi.release(input.binding, object, requestId)
          .then(() => releaseConfirmedFailure(failure)).catch(() => undefined);
      }
    }
    await checkBinding();
    expireReferences(sourceScope, destination);
    if (input.object.kind === "file") {
      notifyProjectFilesChanged(input.sourceProjectId, input.workspaceRoot);
      notifyProjectFilesChanged(input.destinationProjectId, input.workspaceRoot);
    }
  }, { nativeSessionsClosed: input.object.kind === "file", moveIdentity });
}

function expireReferences(source: AgentScope, destination: AgentScope) {
  invalidateInternalReferenceSearch(source);
  invalidateInternalReferenceSearch(destination);
}
