import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import type { InternalReferenceTarget } from "../lib/internalReferences";
import type { AgentWorkspaceBinding } from "../lib/agent-types";
import { withdrawnReference } from "../lib/withdrawn-reference";
import { agentApi } from "../services/agentApi";
import { desktopApi } from "../services/desktopApi";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";

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
        await checkBinding();
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
          if (!resolved.managedPath) {
            pushToast({
              tone: "error",
              title: "打开文件失败",
              detail: "文件引用缺少可用路径。",
            });
            return false;
          }

          await desktopApi.openFile(resolved.managedPath);
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
          title: "打开引用失败",
          detail: "请稍后重试。",
        });
        return false;
      }
    },
    [navigate, pushToast],
  );
}
