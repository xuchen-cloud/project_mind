import { lazy, Suspense, useEffect } from "react";
import { useFilePreviewStore } from "../../state/file-preview-store";

const FileHtmlPreview = lazy(() => import("./FileHtmlPreview").then(module => ({ default: module.FileHtmlPreview })));

/** Source and version controls load only after an actual file is selected. */
export function FilePreviewWorkspace({ workspaceRoot }: { workspaceRoot?: string }) {
  const request = useFilePreviewStore(state => state.request);
  const closePreview = useFilePreviewStore(state => state.closePreview);
  const current = !!request && request.workspaceRoot === workspaceRoot;
  useEffect(() => { if (request && !current) closePreview(); }, [request, current, closePreview]);
  if (!request || !current) return null;
  const identity = `${request.workspaceRoot}:${request.projectId}:${request.documentId}:${request.versionNumber ?? "latest"}`;
  return <section className="flex h-full min-h-0 flex-col overflow-hidden" style={{ paddingTop: "var(--home-toolbar-height, 0px)" }} aria-label="HTML 文件">
    <Suspense fallback={<p className="p-4 text-ui text-text-muted" role="status">正在加载文件…</p>}>
      <FileHtmlPreview key={identity} request={request} onClose={closePreview} />
    </Suspense>
  </section>;
}
