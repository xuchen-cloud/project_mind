import { fileOwnerScope } from "../../lib/file-types";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import type { DocumentRecord, WorkspaceStatusSnapshot } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { commitDocumentVersion } from "../../services/documentVersionAction";
import { openProjectContent } from "../../services/projectContentApi";
import { refreshAll } from "../../hooks/shared";
import { Button, Dialog } from "../../ui/components";
import FileVersions from "./FileVersions";

/** The existing version menu mounts this only after an explicit history action. */
export default function FileVersionHistory({ document, onClose }: { document: DocumentRecord; onClose: () => void }) {
  const queryClient = useQueryClient();
  const workspace = useQuery<WorkspaceStatusSnapshot>({ queryKey: queryKeys.workspaceStatus, enabled: false });
  const root = workspace.data?.currentWorkspace?.rootPath;
  const [binding, setBinding] = useState<AgentWorkspaceBinding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBinding(null); setError(null);
    if (root) void recordDocumentApi.bindingGet(root).then(result => { if (!cancelled) setBinding(result); })
      .catch(failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { cancelled = true; previewRequest.current?.abort(); };
  }, [root]);
  if (!binding) return <Dialog open title={`版本历史 · ${document.baseName}`} onClose={onClose}>
    <p role={error ? "alert" : "status"}>{error ?? (root ? "正在读取工作区信息…" : "请先打开工作区，再查看文件历史。")}</p><Button type="button" onClick={onClose}>关闭</Button>
  </Dialog>;
  return <FileVersions key={`${binding.workspaceId}:${binding.generation}:${document.id}`} binding={binding}
    object={{ workspaceId: binding.workspaceId, scope: fileOwnerScope(document.projectId), kind: "file", id: String(document.id) }}
    title={document.baseName} mimeType={document.mimeType} onClose={onClose}
    onPreviewVersion={version => {
      if (!root) return;
      previewRequest.current?.abort();
      const controller = new AbortController(); previewRequest.current = controller;
      return openProjectContent({ workspaceRoot: root, projectId: document.projectId,
        object: { kind: "file", id: document.id, title: document.name }, view: { versionNumber: version.versionNumber }, expectedBinding: binding, signal: controller.signal,
      }).then(onClose);
    }}
    onRegisterCurrent={expectedVersionNumber => commitDocumentVersion({ documentId: document.id, projectId: document.projectId, managedPath: document.managedPath, expectedVersionNumber })}
    onRestored={async () => {
      await Promise.all([refreshAll(queryClient, document.projectId), queryClient.invalidateQueries({ queryKey: queryKeys.documentVersions(document.id) }), queryClient.invalidateQueries({ queryKey: ["search"] })]);
    }} />;
}
