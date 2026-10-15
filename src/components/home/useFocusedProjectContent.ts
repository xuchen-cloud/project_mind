import { useQuery } from "@tanstack/react-query";
import { getContentLayout } from "../../lib/project-content-layout";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { queryKeys } from "../../lib/queryKeys";
import { projectFileApi } from "../../services/projectFileApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { useProjectContentStore } from "../../state/project-content-store";

/** The content pane owns selection; navigation requests and record routes do not. */
export function useFocusedProjectContent(workspaceRoot: string, projectId: number) {
  const { data: binding } = useQuery({
    queryKey: queryKeys.projectContentBinding(workspaceRoot),
    queryFn: () => recordDocumentApi.bindingGet(workspaceRoot),
    retry: false,
    staleTime: Infinity,
  });
  const layout = useProjectContentStore(state => binding ? getContentLayout(state, { workspaceId: binding.workspaceId, projectId }) : null);
  const selectedId = layout?.panes.find(pane => pane.id === layout.focusedPaneId)?.selectedTabId;
  const object = layout?.tabs.find(tab => tab.id === selectedId)?.object;
  const activeFileId = object?.kind === "file" ? Number(object.id) : null;
  const revision = useProjectFileNavigation(state => state.revisions[projectId] ?? 0);
  const resolved = useQuery({
    queryKey: ["project-navigation-focused-file", workspaceRoot, binding, projectId, activeFileId, revision],
    queryFn: () => projectFileApi.resolve(binding!, { workspaceId: binding!.workspaceId, scope: { kind: "project", projectId }, kind: "file", id: String(activeFileId) }),
    enabled: !!binding && activeFileId !== null,
    retry: false,
  });
  return {
    activeRecordId: object?.kind === "record" ? Number(object.id) : null,
    activeSessionId: object?.kind === "session" ? String(object.id) : null,
    activeFileId,
    activeRelativePath: activeFileId !== null ? resolved.data?.relativePath ?? null : null,
  };
}
