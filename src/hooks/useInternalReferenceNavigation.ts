import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { resolveFixedFileLocator, validateInternalReferenceSourceRef } from "../lib/internalReferences";
import { projectFileApi } from "../services/projectFileApi";
import type { InternalReferenceTarget } from "../lib/internalReferences";
import type { AgentWorkspaceBinding } from "../lib/agent-types";
import { withdrawnReference } from "../lib/withdrawn-reference";
import { agentApi } from "../services/agentApi";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { openProjectContent } from "../services/projectContentApi";

export function useInternalReferenceNavigation() {
  const navigate = useNavigate();
  const { pushToast } = useFeedbackStore();

  return useCallback(
    async function openReference(reference: InternalReferenceTarget, expected?: AgentWorkspaceBinding): Promise<boolean> {
      const checkBinding = async () => {
        if (!expected) return;
        const current = (await agentApi.statusGet()).binding;
        if (!current || current.workspaceId !== expected.workspaceId || current.generation !== expected.generation) throw new Error("工作区已切换，请回到引用所属工作区。");
      };
      try {
        const documentBinding = reference.refKind === "document" ? expected ?? (await agentApi.statusGet()).binding : null;
        if (reference.refKind === "document" && !documentBinding) throw new Error("请先打开工作区");
        await checkBinding();
        if (reference.sourceRef) {
          const source = validateInternalReferenceSourceRef(reference.sourceRef);
          if (reference.refKind !== "document" || source.object.id !== String(reference.refId)
            || source.object.workspaceId !== documentBinding!.workspaceId)
            throw new Error("引用不属于当前工作区或文件");
          // Verify exact retained bytes. Never resolve a live path or substitute
          // a newer version when historical evidence is unavailable.
          await projectFileApi.readBytes(documentBinding!, { object: source.object,
            versionNumber: source.fileVersion!, expectedContentHash: source.revision });
          const workspace = await projectMindApi.workspaceStatusGet();
          if (!workspace.currentWorkspace) throw new Error("请先打开工作区");
          await openProjectContent({ workspaceRoot: workspace.currentWorkspace.rootPath, projectId: source.object.scope.kind === "project" ? source.object.scope.projectId : null,
            object: { kind: "file", id: reference.refId, title: reference.label },
            view: { versionNumber: source.fileVersion!, line: undefined, page: undefined, sourceLocator: undefined,
              ...resolveFixedFileLocator(source) }, expectedBinding: documentBinding! });
          return true;
        }
        const resolved = await projectMindApi.internalReferenceResolve({
          kind: reference.refKind,
          id: reference.refId,
        });
        await checkBinding();

        if (!resolved) {
          pushToast({
            tone: "error",
            title: "引用已失效",
            detail: "对应的记录可能已经被删除或移动。",
          });
          return false;
        }

        if (resolved.kind === "document") {
          if (resolved.id !== reference.refId || !(resolved.scope === "workspace" && resolved.projectId === null
            || resolved.scope === "project" && Number.isSafeInteger(resolved.projectId) && resolved.projectId! > 0))
            throw new Error("引用文件身份或归属不符");
          const workspace = await projectMindApi.workspaceStatusGet();
          if (!workspace.currentWorkspace) throw new Error("请先打开工作区");
          await openProjectContent({ workspaceRoot: workspace.currentWorkspace.rootPath, projectId: resolved.projectId,
            object: { kind: "file", id: resolved.id, title: resolved.label }, expectedBinding: documentBinding! });
          return true;
        }

        navigate(resolved.route);
        return true;
      } catch (failure) {
        const withdrawn = withdrawnReference(failure);
        if (withdrawn) {
          let binding: AgentWorkspaceBinding | null = null;
          if (withdrawn.restoreAvailable) {
            try { binding = (await agentApi.statusGet()).binding; } catch { /* Recovery remains unavailable until a bound Workspace opens. */ }
          }
          const recoveryBinding = binding?.workspaceId === withdrawn.workspaceId ? binding : null;
          let restoring = false;
          pushToast({ tone: "info", title: "引用记录已撤回", detail: !withdrawn.restoreAvailable ? "此记录暂时无法恢复。" : recoveryBinding ? "恢复记录后可继续查看原文。" : "请回到记录所属工作区后恢复记录。",
            ...(recoveryBinding && withdrawn.creationOperationId && withdrawn.withdrawalRevision !== null ? { action: { label: "恢复并打开", onClick: () => {
              if (restoring) return;
              restoring = true;
              void (async () => {
                try {
                  const current = (await agentApi.statusGet()).binding;
                  if (!current || current.workspaceId !== recoveryBinding.workspaceId || current.generation !== recoveryBinding.generation) throw new Error("工作区已切换");
                  await agentApi.operationRestoreCreated(current, { creationOperationId: withdrawn.creationOperationId!, expectedWithdrawalRevision: withdrawn.withdrawalRevision! });
                  await openReference(reference, current);
                } catch {
                  pushToast({ tone: "error", title: "恢复引用失败", detail: "记录或工作区状态已变化，请重新打开引用后重试。" });
                } finally { restoring = false; }
              })();
            } } } : {}),
          });
          return false;
        }
        pushToast({
          tone: "error",
          title: reference.sourceRef ? "历史文件不可用" : "打开引用失败",
          detail: reference.sourceRef ? (failure instanceof Error ? failure.message : String(failure)) : "请稍后重试。",
        });
        return false;
      }
    },
    [navigate, pushToast],
  );
}
