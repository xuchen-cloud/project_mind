import { Navigate, useParams } from "react-router-dom";

import { parseRouteId, todayPath } from "../../lib/formatters";

export function ProjectSummaryRedirectPage() {
  const params = useParams();
  const projectId = parseRouteId(params.projectId);

  if (projectId === null) {
    return <Navigate to={todayPath()} replace />;
  }

  return <Navigate to={`/projects/${projectId}`} replace />;
}

export const ProjectSummaryFocusPage = ProjectSummaryRedirectPage;
