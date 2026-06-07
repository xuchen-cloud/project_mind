import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/500.css";
import "@fontsource/work-sans/600.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./styles/app.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, RouterProvider, createHashRouter } from "react-router-dom";

import { WorkspaceLayout } from "./App";
import { ProjectOverviewPage } from "./components/project/ProjectOverviewPage";
import { ProjectNoteFocusPage } from "./components/project/ProjectNoteFocusPage";
import { ProjectSummaryRedirectPage } from "./components/project/ProjectSummaryFocusPage";
import { SettingsRouteBridge } from "./components/settings/SettingsDialog";
import { TodayPage } from "./components/today/TodayPage";

const router = createHashRouter([
  {
    element: <WorkspaceLayout />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: "projects", element: <Navigate to="/today" replace /> },
      { path: "today", element: <TodayPage /> },
      { path: "projects/:projectId", element: <ProjectOverviewPage /> },
      { path: "projects/:projectId/summary", element: <ProjectSummaryRedirectPage /> },
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
