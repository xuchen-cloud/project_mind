import { useEffect, useState } from "react";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { getErrorMessage } from "../../lib/errors";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
import { Dialog } from "../../ui/components";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { openProjectContent } from "../../services/projectContentApi";
import { getContentLayout } from "../../lib/project-content-layout";
import { useProjectContentStore } from "../../state/project-content-store";
import { resolveFixedFileLocator, validateInternalReferenceSourceRef } from "../../lib/internalReferences";

/** Shared main-app destination for Chat and trajectory file links. */
export function ProjectFilePreviewLayer({ currentProjectId, workspaceRoot }: { currentProjectId: number | null; workspaceRoot?: string }) {
  const request = useProjectFileNavigation(state => state.request);
  const close = useProjectFileNavigation(state => state.close);
  const [error, setError] = useState("");
  useEffect(() => {
    if (request && request.projectId !== currentProjectId) close();
  }, [request, currentProjectId, close]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    if (!request || request.projectId !== currentProjectId) return;
    void (async () => {
      if (!workspaceRoot) throw new Error("请先打开工作区");
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      const source = request.sourceRef ? validateInternalReferenceSourceRef(request.sourceRef) : null;
      if (source && (source.object.workspaceId !== binding.workspaceId || source.object.scope.kind !== "project" || source.object.scope.projectId !== request.projectId)) throw new Error("文件引用不属于当前项目");
      const file = source ? await (async () => {
        const bytes = await projectFileApi.readBytes(binding, { object: source.object, versionNumber: source.fileVersion!, expectedContentHash: source.revision });
        if (bytes.object.id !== source.object.id || bytes.versionNumber !== source.fileVersion || bytes.contentHash !== source.revision) throw new Error("历史文件版本不符");
        return { object: source.object, name: bytes.name, state: "ready" as const, reason: null };
      })() : await (async () => {
        const path = await projectDirectoryApi.resolveReference(request.projectId, request.path);
        controller.signal.throwIfAborted();
        return projectFileApi.register(binding, request.projectId, path);
      })();
      if (controller.signal.aborted) return;
      if (file.state !== "ready") throw new Error(file.reason ?? "文件身份需要核对");
      const layout = getContentLayout(useProjectContentStore.getState(), { workspaceId: binding.workspaceId, projectId: request.projectId });
      const origin = layout.tabs.find(tab => tab.object.kind === "session" && String(tab.object.id) === request.originSessionId);
      const originPane = origin && layout.panes.find(pane => pane.tabIds.includes(origin.id));
      const otherPane = originPane && layout.panes.length === 2 ? layout.panes.find(pane => pane.id !== originPane.id)?.id : undefined;
      await openProjectContent({ workspaceRoot, projectId: request.projectId, object: { kind: "file", id: file.object.id, title: file.name },
        ...(otherPane ? { paneId: otherPane } : {}),
        ...(source ? { view: { versionNumber: source.fileVersion!, line: undefined, page: undefined, sourceLocator: undefined, ...resolveFixedFileLocator(source) } }
          : request.line ? { view: { line: request.line } } : {}), signal: controller.signal, expectedBinding: binding });
      close();
    })().catch(cause => { if (!controller.signal.aborted) setError(getErrorMessage(cause, "无法打开项目文件")); });
    return () => controller.abort();
  }, [request, currentProjectId, workspaceRoot, close]);
  if (!request || request.projectId !== currentProjectId) return null;
  return <Dialog open title="项目文件" onClose={close}>
    {error ? <p role="alert">{error}</p> : <p role="status">正在定位文件…</p>}
  </Dialog>;
}
