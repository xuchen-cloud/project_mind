import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/500.css";
import "@fontsource/work-sans/600.css";
import "./styles.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createHashRouter } from "react-router-dom";

import App from "./App";

const router = createHashRouter([
  {
    path: "/",
    element: <App />,
  },
  {
    path: "/projects/:projectId",
    element: <App />,
  },
  {
    path: "/projects/:projectId/activities/:activityId",
    element: <App />,
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
