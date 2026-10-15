import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { parseFocusTodoId } from "../../lib/formatters";
import { queryKeys } from "../../lib/queryKeys";
import { RESIDENT_PROJECT_QUERY_OPTIONS } from "../../lib/resident-pages";
import { projectMindApi } from "../../services/projectMindApi";
import { useUiStore } from "../../state/ui-store";
import { TodoModuleRail } from "../../todo";

export function WorkspaceTodoRail({
  projectId,
  visible = true,
}: {
  projectId: number | null;
  visible?: boolean;
}) {
  const [searchParams] = useSearchParams();
  const projectTodoViewMode = useUiStore((state) => state.projectTodoViewMode);
  const setProjectTodoViewMode = useUiStore((state) => state.setProjectTodoViewMode);
  const openInternalReference = useInternalReferenceNavigation();
  const openContactMention = useContactMentionNavigation();
  const workspaceView = projectId === null || projectTodoViewMode === "workspace";
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: visible && projectId !== null,
  });
  const tagsQuery = useQuery({
    queryKey: workspaceView
      ? queryKeys.projectTags.workspace
      : queryKeys.projectTags.project(projectId),
    queryFn: () => projectMindApi.projectTagSettingsGet(
      workspaceView ? {} : { projectId: projectId as number },
    ),
    enabled: visible,
    ...(workspaceView ? {} : RESIDENT_PROJECT_QUERY_OPTIONS),
  });
  const activeProject = projectsQuery.data?.find((project) => project.id === projectId);

  return (
    <TodoModuleRail
      scope={workspaceView ? { kind: "workspace" } : { kind: "current-project", projectId: projectId as number }}
      enabled={visible}
      focusTodoId={parseFocusTodoId(searchParams.get("focus"))}
      availableTags={tagsQuery.data?.tags ?? []}
      canCreateTodo={workspaceView || activeProject?.isArchived === false}
      showViewModeSwitch={projectId !== null}
      onViewModeChange={setProjectTodoViewMode}
      onOpenInternalReference={openInternalReference}
      onOpenContactMention={openContactMention}
    />
  );
}
