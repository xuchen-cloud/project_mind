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
import { ActivityPage } from "./components/activity/ActivityPage";
import { SettingsRouteBridge } from "./components/settings/SettingsDialog";
import { TodayPage } from "./components/today/TodayPage";

const router = createHashRouter([
  {
    element: <WorkspaceLayout />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", element: <EmptyProjectRedirect /> },
      { path: "today", element: <TodayPage /> },
      { path: "projects/:projectId", element: <ProjectOverviewPage /> },
      {
        path: "projects/:projectId/activities/:activityId",
        element: <ActivityPage />,
      },
      {
        path: "settings/:section",
        element: <SettingsRouteBridge />,
      },
    ],
  },
]);

function EmptyProjectRedirect() {
  return (
    <div className="flex h-full items-center justify-center text-body text-text-soft">
      选择一个项目，或新建一个开始使用。
    </div>
  );
}

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
