import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/500.css";
import "@fontsource/work-sans/600.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./styles/file-icons.css";
import "./styles/app.css";

import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Navigate, RouterProvider, createHashRouter, useParams } from "react-router-dom";

import { WorkspaceLayout } from "./App";
import { ProjectOverviewPage } from "./components/project/ProjectOverviewPage";
import { SettingsRouteBridge } from "./components/settings/SettingsDialog";
import { WorkspacePage } from "./components/today/WorkspacePage";
import { createProjectMindQueryClient } from "./lib/queryClient";

const ProjectNoteFocusPage = lazy(() =>
  import("./components/project/ProjectNoteFocusPage").then((module) => ({
    default: module.ProjectNoteFocusPage,
  })),
);
const WorkspaceRecordFocusPage = lazy(() =>
  import("./components/today/WorkspaceRecordFocusPage").then((module) => ({
    default: module.WorkspaceRecordFocusPage,
  })),
);

function RouteFallback() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center text-sm text-text-muted">
      正在打开记录…
    </div>
  );
}

function deferred(element: React.ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>;
}

function ProjectNoteFocusRoute() {
  const params = useParams();
  return deferred(
    <ProjectNoteFocusPage key={`${params.projectId ?? ""}:${params.noteId ?? ""}`} />,
  );
}

const router = createHashRouter([
  {
    element: <WorkspaceLayout cacheProjectOverviewPages />,
    children: [
      { index: true, element: <Navigate to="/workspace" replace /> },
      { path: "projects", element: <Navigate to="/workspace" replace /> },
      { path: "workspace", element: <WorkspacePage /> },
      { path: "workspace/records/:noteId", element: deferred(<WorkspaceRecordFocusPage />) },
      { path: "projects/:projectId", element: <ProjectOverviewPage /> },
      {
        path: "projects/:projectId/records/:noteId",
        element: <ProjectNoteFocusRoute />,
      },
      {
        path: "settings/:section",
        element: <SettingsRouteBridge />,
      },
    ],
  },
]);

const queryClient = createProjectMindQueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
