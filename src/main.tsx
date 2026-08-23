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
import { WorkspacePage } from "./components/workspace/WorkspacePage";
import { createProjectMindQueryClient } from "./lib/queryClient";
import {
  loadProjectNoteFocusPageModule,
  loadWorkspaceRecordFocusPageModule,
} from "./routes/record-focus-modules";
import { PageLoadingSkeleton } from "./ui/components";

const ProjectNoteFocusPage = lazy(loadProjectNoteFocusPageModule);
const WorkspaceRecordFocusPage = lazy(loadWorkspaceRecordFocusPageModule);

function RouteFallback() {
  return <PageLoadingSkeleton variant="record" label="正在打开记录" />;
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
