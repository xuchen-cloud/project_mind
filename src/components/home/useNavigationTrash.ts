import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import { fileOwnerScope } from "../../lib/file-types";
import { getErrorMessage } from "../../lib/errors";
import { refreshDirectoryMutation } from "../../lib/project-directory-query";
import { desktopApi } from "../../services/desktopApi";
import { projectFileApi } from "../../services/projectFileApi";
import { projectDirectoryApi, type PreparedNavigationTrash } from "../../services/projectDirectoryApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { useFeedbackStore } from "../../state/feedback-store";
import type { FileSelectionItem } from "./useFileSelection";

export interface NavigationTrashResult {
  succeeded: FileSelectionItem[];
  failed: Array<{ item: FileSelectionItem; message: string }>;
}

/** Each original has its own durable native receipt. A selected ancestor covers
 * its descendants; independent failures never erase a successful item's result. */
export function useNavigationTrash({ workspaceRoot, rootPath, projectId, binding }: {
  workspaceRoot?: string; rootPath: string; projectId: number | null; binding?: AgentWorkspaceBinding;
}) {
  const client = useQueryClient();
  const pushToast = useFeedbackStore(state => state.pushToast);
  const epoch = useRef(0);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    epoch.current++; operation.current = false; setBusy(false);
    return () => { epoch.current++; };
  }, [workspaceRoot, rootPath, projectId, binding?.workspaceId, binding?.generation]);

  const capture = (selection: readonly FileSelectionItem[]) => {
    const generation = epoch.current;
    const current = () => generation === epoch.current;
    const unique = [...new Map(selection.map(item => [item.relativePath, item])).values()];
    const items = unique.filter(item => !unique.some(parent => parent.kind === "directory"
      && parent.relativePath !== item.relativePath && item.relativePath.startsWith(`${parent.relativePath}/`)));
    // Capture when the menu opens. A later Workspace generation cannot inherit
    // the selected paths, even if it reopens at the same root.
    const captured = workspaceRoot ? recordDocumentApi.bindingGet(workspaceRoot).then(
      value => ({ value }), error => ({ error }),
    ) : Promise.resolve({ error: new Error("工作区信息尚未就绪，请刷新后重试。") });

    return async (): Promise<NavigationTrashResult | undefined> => {
      if (!current() || operation.current || !items.length) return;
      operation.current = true; setBusy(true);
      try {
        const result = await captured;
        if (!current()) return;
        if ("error" in result) throw result.error;
        const actualBinding = result.value;
        if (binding && (binding.workspaceId !== actualBinding.workspaceId || binding.generation !== actualBinding.generation)) {
          throw new Error("工作区已切换，请刷新后重新选择。");
        }
        const prepare = async (item: FileSelectionItem) => {
          if (!item.relativePath) throw new Error("文件不在当前归属目录内，请刷新后重试。");
          if (item.fileId !== undefined) {
            const file = await projectFileApi.resolve(actualBinding, {
              workspaceId: actualBinding.workspaceId, scope: fileOwnerScope(projectId), kind: "file", id: String(item.fileId),
            });
            if (!current()) return;
            if (file.state !== "ready" || file.relativePath !== item.relativePath) throw new Error("文件身份或位置已变化，请刷新后重新选择。");
          }
          const prepared = await projectDirectoryApi.prepareTrash({ binding: actualBinding, projectId, relativePath: item.relativePath });
          if (!current()) return;
          if (prepared.kind !== item.kind || prepared.relativePath !== item.relativePath
            || (item.fileId !== undefined && !prepared.files.some(file => file.fileId === item.fileId))) {
            throw new Error("所选项目的类型或身份已变化，请刷新后重新选择。");
          }
          return prepared;
        };
        const prepared: Array<{ item: FileSelectionItem; value: PreparedNavigationTrash }> = [];
        for (const item of items) {
          const value = await prepare(item);
          if (!current() || !value) return;
          prepared.push({ item, value });
        }
        const confirmed = await desktopApi.confirm(`将所选的 ${items.length} 项移入系统回收站？\n选中文件夹包含其中所有内容，包括尚未纳管的文件。文件身份、历史和恢复资料会保留。`, "删除所选项目");
        if (!current() || !confirmed) return;
        // A changed member/type/session aborts before the first mutation. Each
        // native commit then performs its own final identity/CAS checks.
        for (const { item, value } of prepared) {
          const after = await prepare(item);
          if (!current() || !after) return;
          const members = (plan: PreparedNavigationTrash) => [...plan.files].sort((a, b) => a.fileId - b.fileId);
          if (after.token !== value.token || after.identityToken !== value.identityToken
            || JSON.stringify(members(after)) !== JSON.stringify(members(value))) {
            throw new Error(`“${item.relativePath}”已变化，请重新选择后重试。`);
          }
        }
        const outcome: NavigationTrashResult = { succeeded: [], failed: [] };
        for (const { item, value } of prepared) {
          if (!current()) return;
          try {
            await projectDirectoryApi.trash({ binding: actualBinding, projectId, relativePath: item.relativePath,
              token: value.token, confirmed: true, requestId: crypto.randomUUID() });
            outcome.succeeded.push(item);
          } catch (error) { outcome.failed.push({ item, message: getErrorMessage(error, "无法移入系统回收站") }); }
        }
        if (!current()) return;
        let refreshError: string | undefined;
        if (outcome.succeeded.length) {
          try { await refreshDirectoryMutation(client, { rootPath, projectId, workspaceRoot, binding: actualBinding },
            outcome.succeeded.map(item => item.relativePath), current); }
          catch (error) { refreshError = getErrorMessage(error, "无法刷新文件列表"); }
        }
        if (!current()) return;
        const failures = outcome.failed.slice(0, 3).map(({ item, message }) => `${item.relativePath}：${message}`).join("\n");
        pushToast({ tone: outcome.failed.length || refreshError ? "error" : "success",
          title: outcome.failed.length ? `已移入回收站 ${outcome.succeeded.length} 项，${outcome.failed.length} 项未删除` : `已移入系统回收站 ${outcome.succeeded.length} 项`,
          detail: [failures, outcome.failed.length > 3 ? `另有 ${outcome.failed.length - 3} 项未删除，已保留选择。` : "",
            refreshError ? `操作已完成，刷新失败：${refreshError}` : ""].filter(Boolean).join("\n") || undefined });
        return outcome;
      } catch (error) {
        if (current()) pushToast({ tone: "error", title: "无法删除所选项目", detail: getErrorMessage(error, "请刷新后重试。") });
      } finally { if (current()) { operation.current = false; setBusy(false); } }
    };
  };
  return { busy, capture };
}
