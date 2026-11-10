import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import { queryKeys } from "../../lib/queryKeys";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectMindApi } from "../../services/projectMindApi";
import { moveContentOwner } from "../../services/contentOwnerMoveApi";
import { Button } from "../../ui/components/Button";
import { Dialog } from "../../ui/components/Dialog";
import { MoveDestinationDialog } from "./MoveDestinationDialog";

type MoveObject = { kind: "record" | "file"; id: number };
interface MoveSource {
  workspaceRoot: string;
  sourceProjectId: number | null;
  object: MoveObject;
}
interface Props extends MoveSource { onClose: () => void }

/** Capture the source at the menu action, and discard it when navigation changes. */
export function useContentOwnerMoveDialog(workspaceRoot: string | undefined, sourceProjectId: number | null) {
  const [source, setSource] = useState<MoveSource | null>(null);
  useEffect(() => { setSource(null); }, [workspaceRoot, sourceProjectId]);
  return {
    canMove: !!workspaceRoot,
    openMove(object: MoveObject) {
      if (workspaceRoot) setSource({ workspaceRoot, sourceProjectId, object: { ...object } });
    },
    moveDialog: source && source.workspaceRoot === workspaceRoot && source.sourceProjectId === sourceProjectId
      ? <ContentOwnerMoveDialog key={JSON.stringify(source)} {...source} onClose={() => setSource(null)} /> : null,
  };
}

export function ContentOwnerMoveDialog(props: Props) {
  const binding = useQuery({
    queryKey: queryKeys.projectContentBinding(props.workspaceRoot),
    queryFn: () => recordDocumentApi.bindingGet(props.workspaceRoot),
    enabled: !!props.workspaceRoot,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  // A new generation/object must remount MoveDestinationDialog, including its pending state.
  const identity = JSON.stringify([props.workspaceRoot, binding.data?.workspaceId, binding.data?.generation,
    props.sourceProjectId, props.object.kind, props.object.id]);
  return <BoundMoveDialog key={identity} {...props} binding={binding.data} bindingLoading={binding.isFetching}
    bindingError={binding.error} retryBinding={() => { void binding.refetch(); }} />;
}

function BoundMoveDialog({ workspaceRoot, sourceProjectId, object, onClose, binding, bindingLoading,
  bindingError, retryBinding }: Props & {
  binding?: AgentWorkspaceBinding; bindingLoading: boolean; bindingError: Error | null; retryBinding: () => void;
}) {
  const queryClient = useQueryClient();
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const projects = useQuery({
    queryKey: ["content-owner-move-projects", workspaceRoot, binding?.workspaceId, binding?.generation,
      sourceProjectId, object.kind, object.id],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: !!binding && !bindingLoading && !bindingError,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const workspace = queryClient.getQueryData<{ currentWorkspace?: { rootPath: string; displayName?: string } }>(queryKeys.workspaceStatus)?.currentWorkspace;
  const error = bindingError ?? projects.error;
  const loading = !workspaceRoot || bindingLoading || !binding || projects.isPending || projects.isFetching || !!error;
  const title = object.kind === "record" ? "移动记录" : "移动文件";
  if (error) return <Dialog open title={title} onClose={onClose} footer={<>
    <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
    <Button type="button" disabled={bindingLoading || projects.isFetching} onClick={() => { if (bindingError) retryBinding(); else void projects.refetch(); }}>重新加载移动目标</Button>
  </>}><p role="alert" className="text-body text-danger">{error.message}</p></Dialog>;
  return <MoveDestinationDialog title={title}
      workspaceName={workspace?.rootPath === workspaceRoot && workspace.displayName ? workspace.displayName : "当前工作区"}
      projects={projects.data ?? []} currentProjectId={sourceProjectId} loading={loading}
      onClose={onClose} onMove={async destinationProjectId => {
        if (!binding || loading) throw new Error("移动目标尚未加载完成，请重试。");
        await moveContentOwner({ workspaceRoot, binding, sourceProjectId, destinationProjectId, object });
        if (!active.current) return;
        await Promise.all([
          ...[sourceProjectId, destinationProjectId].map(id => queryClient.invalidateQueries({
            queryKey: id === null ? queryKeys.workspacePage : queryKeys.projectPage(id),
          })),
          ...(object.kind === "file" ? [queryClient.invalidateQueries({ queryKey: queryKeys.documentVersions(object.id) })] : []),
        ]);
      }} />;
}
