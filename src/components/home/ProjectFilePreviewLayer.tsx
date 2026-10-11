import { useEffect, useState } from "react";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { getErrorMessage } from "../../lib/errors";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
import { Dialog } from "../../ui/components";
import { ProjectDirectoryFilePreviewDialog } from "./ProjectDirectoryBrowser";

/** Shared main-app destination for Chat and trajectory file links. */
export function ProjectFilePreviewLayer({ currentProjectId }: { currentProjectId: number | null }) {
  const request = useProjectFileNavigation(state => state.request);
  const close = useProjectFileNavigation(state => state.close);
  const [relativePath, setRelativePath] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (request && request.projectId !== currentProjectId) close();
  }, [request, currentProjectId, close]);
  useEffect(() => {
    let active = true;
    setRelativePath(null); setError("");
    if (!request || request.projectId !== currentProjectId) return;
    void projectDirectoryApi.resolveReference(request.projectId, request.path).then(path => {
      if (active) setRelativePath(path);
    }, cause => { if (active) setError(getErrorMessage(cause, "无法打开项目文件")); });
    return () => { active = false; };
  }, [request, currentProjectId]);
  if (!request || request.projectId !== currentProjectId) return null;
  if (relativePath !== null) return <ProjectDirectoryFilePreviewDialog key={`${request.projectId}:${relativePath}`}
    projectId={request.projectId} file={{ name: relativePath.split("/").pop() ?? relativePath, relativePath }} line={request.line} onClose={close} />;
  return <Dialog open title="项目文件" onClose={close}>
    {error ? <p role="alert">{error}</p> : <p role="status">正在定位文件…</p>}
  </Dialog>;
}
