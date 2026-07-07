import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/500.css";
import "@fontsource/work-sans/600.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./styles/file-icons.css";
import "./styles/app.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, RouterProvider, createHashRouter } from "react-router-dom";

import { WorkspaceLayout } from "./App";
import { ProjectOverviewPage } from "./components/project/ProjectOverviewPage";
import { ProjectNoteFocusPage } from "./components/project/ProjectNoteFocusPage";
import { SettingsRouteBridge } from "./components/settings/SettingsDialog";
import { WorkspacePage } from "./components/today/WorkspacePage";
import { WorkspaceRecordFocusPage } from "./components/today/WorkspaceRecordFocusPage";

const router = createHashRouter([
  {
    element: <WorkspaceLayout cacheProjectOverviewPages />,
    children: [
      { index: true, element: <Navigate to="/workspace" replace /> },
      { path: "projects", element: <Navigate to="/workspace" replace /> },
      { path: "workspace", element: <WorkspacePage /> },
      { path: "workspace/records/:noteId", element: <WorkspaceRecordFocusPage /> },
      { path: "projects/:projectId", element: <ProjectOverviewPage /> },
      { path: "projects/:projectId/records/:noteId", element: <ProjectNoteFocusPage /> },
      {
        path: "settings/:section",
        element: <SettingsRouteBridge />,
      },
    ],
  },
]);

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
