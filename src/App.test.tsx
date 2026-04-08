import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsRouteBridge } from "./components/settings/SettingsDialog";

vi.mock("./services/projectMindApi", () => ({
  projectMindApi: {
    projectsList: vi.fn(async () => []),
    workspaceSearch: vi.fn(async () => []),
    activityList: vi.fn(async () => []),
    richTextStyleGet: vi.fn(async () => ({
      body: {
        fontPreset: "workspace_sans",
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
      },
      headings: {
        fontPreset: "workspace_sans",
        lineHeight: 1.35,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
        h1SizePx: 24,
        h2SizePx: 20,
        h3SizePx: 16,
      },
      list: {
        fontPreset: "workspace_sans",
        fontSizePx: 14,
        lineHeight: 1.6,
        paragraphSpacingBeforePx: 12,
        paragraphSpacingAfterPx: 0,
      },
    })),
    activitySettingsGet: vi.fn(async () => ({
      activityAttributeOptions: [],
      activityStatusOptions: [
        {
          id: 1,
          label: "待启动",
          colorKey: "amber",
          isSystem: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
    })),
    fileTagSettingsGet: vi.fn(async () => ({
      tags: [],
    })),
    recordTypeSettingsGet: vi.fn(async () => ({
      recordTypes: [
        {
          id: 1,
          key: "quick_note",
          label: "原始记录",
          colorKey: "slate",
          templateHtml: "<p></p>",
          isDefault: true,
          usageCount: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    })),
    aiSettingsGet: vi.fn(async () => ({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "device_bound_encrypted",
    })),
    projectGetOverview: vi.fn(async () => ({
      project: null,
      activityFeed: [],
      projectDocuments: [],
      conclusionGroups: [],
      unfinishedTodos: [],
      finishedTodos: [],
    })),
  },
}));

import { WorkspaceLayout } from "./App";
import { useUiStore } from "./state/ui-store";

describe("WorkspaceLayout", () => {
  beforeEach(() => {
    useUiStore.setState({
      createProjectOpen: false,
      createActivityOpen: false,
      settingsOpen: false,
      settingsSection: "activity",
      projectComposer: null,
      projectSidebarCollapsed: false,
      todoRailCollapsed: false,
    });
  });

  it("shows the empty state and opens create project dialog", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [{ index: true, element: <div>workspace outlet</div> }],
        },
      ],
      { initialEntries: ["/"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/当前还没有项目。需要开始整理时再创建即可/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "创建项目" }));
    expect(await screen.findByText("Project Mind Workspace")).toBeInTheDocument();
    expect(screen.getByText("Project Mind Workspace")).toBeInTheDocument();
  });

  it("opens settings as a dialog even when there are no projects", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [{ index: true, element: <div>workspace outlet</div> }],
        },
      ],
      { initialEntries: ["/"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /活动标签/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /文件标签/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /记录类型/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI 设置/ })).toBeInTheDocument();
  });

  it("opens rich text settings from the route bridge", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "projects", element: <div>projects route</div> },
            { path: "settings/:section", element: <SettingsRouteBridge /> },
          ],
        },
      ],
      { initialEntries: ["/settings/rich-text"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /富文本样式/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "富文本样式" })).toBeInTheDocument();
  });

  it("opens file tag settings from the route bridge", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <div>workspace outlet</div> },
            { path: "projects", element: <div>projects route</div> },
            { path: "settings/:section", element: <SettingsRouteBridge /> },
          ],
        },
      ],
      { initialEntries: ["/settings/file-tags"] },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /文件标签/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "文件标签" })).toBeInTheDocument();
  });
});
