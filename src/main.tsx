import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/500.css";
import "@fontsource/work-sans/600.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./styles/app.css";

import React, { Suspense, lazy } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Navigate, RouterProvider, createHashRouter, useParams } from "react-router-dom";

import { WorkspaceLayout } from "./App";
import { ProjectOverviewPage } from "./components/project/ProjectOverviewPage";
import { WorkspacePage } from "./components/workspace/WorkspacePage";
import { createProjectMindQueryClient } from "./lib/queryClient";
import { renderReactRoot } from "./lib/react-root";
import {
  loadProjectNoteFocusPageModule,
  loadWorkspaceRecordFocusPageModule,
} from "./routes/record-focus-modules";
import { PageLoadingSkeleton } from "./ui/components";

// Opt-in native acceptance observes the real App's Workspace close path.
if (import.meta.env.OFFICE_PERFORMANCE) {
  const config = (window as Window & {__OFFICE_PERFORMANCE__?: {page?: string; workspaceRoot: string; reportUrl: string}}).__OFFICE_PERFORMANCE__;
  if (config?.page === 'app') void import('../scripts/office-performance/app-workspace-race').then(module => module.installAppWorkspaceRace(config));
}

const ProjectNoteFocusPage = lazy(loadProjectNoteFocusPageModule);
const WorkspaceRecordFocusPage = lazy(loadWorkspaceRecordFocusPageModule);
const SettingsRouteBridge = lazy(() =>
  import("./components/settings/SettingsDialog").then(module => ({ default: module.SettingsRouteBridge })),
);

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
        element: <Suspense fallback={null}><SettingsRouteBridge /></Suspense>,
      },
    ],
  },
]);

const queryClient = createProjectMindQueryClient();
// A replacement router must mount with its own initial state and subscriptions.
const routerGeneration = import.meta.hot
  ? (import.meta.hot.data.routerGeneration = (import.meta.hot.data.routerGeneration ?? 0) + 1)
  : 0;

renderReactRoot(
  document.getElementById("root")!,
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider key={routerGeneration} router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
  import.meta.hot?.data,
);

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => router.dispose());
}
