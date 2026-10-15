import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { WorkspaceOverviewSidebar } from "../workspace/WorkspaceOverviewSidebar";
import { HomeNoteSidebar } from "./HomeNoteSidebar";
import { HomeProjectSidebar } from "./HomeProjectSidebar";
import { HomeSidebarFooter, HomeWorkspaceActionsContext, HomeWorkspaceIdentity } from "./HomeWorkspaceIdentity";

vi.mock("../../services/projectMindApi", () => ({ projectMindApi: {
  projectTagSettingsGet: async () => ({ tags: [] }),
} }));
vi.mock("./ProjectSidebarSessions", () => ({ ProjectSidebarSessions: () => <section>会话</section> }));
vi.mock("./HomeProjectFiles", () => ({ HomeProjectFiles: () => <section>文件</section> }));

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState(createUiStoreState());
});

function withActions(element: ReactElement) {
  const actions = { workspaceName: "研究工作区", switchWorkspace: vi.fn(), openSettings: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(<QueryClientProvider client={client}>
    <HomeWorkspaceActionsContext.Provider value={actions}>{element}</HomeWorkspaceActionsContext.Provider>
  </QueryClientProvider>);
  return { ...result, actions };
}

it("shows the current workspace above the brand and keeps its navigation action", () => {
  const onOpenWorkspace = vi.fn();
  const { actions } = withActions(<HomeWorkspaceIdentity onOpenWorkspace={onOpenWorkspace} />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "研究工作区" })).toHaveClass("home-side__identity-title");
  expect(screen.getByRole("img", { name: "NoriMind" }).parentElement).toHaveClass("home-side__identity-subtitle");
  fireEvent.click(screen.getByRole("button", { name: "研究工作区" }));
  expect(onOpenWorkspace).toHaveBeenCalledOnce();
  expect(actions.switchWorkspace).not.toHaveBeenCalled();
  expect(actions.openSettings).not.toHaveBeenCalled();
});

it("shows the project above the brand and workspace, updating names with the current context", () => {
  const onOpenWorkspace = vi.fn();
  const { actions, rerender } = withActions(<HomeWorkspaceIdentity projectName="Alpha" onOpenWorkspace={onOpenWorkspace} />);
  expect(screen.getByText("Alpha")).toHaveClass("home-side__identity-title");
  expect(screen.getByText("Alpha")).toHaveAttribute("title", "Alpha");
  const workspace = screen.getByRole("button", { name: "NoriMind · 研究工作区" });
  expect(workspace).toHaveClass("home-side__identity-subtitle");
  fireEvent.click(workspace);
  expect(onOpenWorkspace).toHaveBeenCalledOnce();
  expect(actions.switchWorkspace).not.toHaveBeenCalled();
  rerender(<HomeWorkspaceActionsContext.Provider value={{ ...actions, workspaceName: "个人工作区" }}>
    <HomeWorkspaceIdentity projectName="Beta" onOpenWorkspace={onOpenWorkspace} />
  </HomeWorkspaceActionsContext.Provider>);
  expect(screen.getByText("Beta")).toHaveAttribute("title", "Beta");
  expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "NoriMind · 个人工作区" })).toHaveAttribute("title", "NoriMind · 个人工作区");
});

it("shows the current workspace and invokes each footer action independently", () => {
  const { actions, rerender } = withActions(<HomeSidebarFooter />);
  const footer = screen.getByRole("group", { name: "工作区操作" });
  expect(footer).toHaveClass("home-side__footer");
  const switchButton = within(footer).getByRole("button", { name: "切换 Workspace" });
  const settingsButton = within(footer).getByRole("button", { name: "设置" });
  expect(switchButton).toHaveTextContent("研究工作区");
  expect(switchButton).toHaveClass("home-side__footer-workspace");
  expect(switchButton).toHaveAttribute("title", "切换工作区");
  expect(switchButton.querySelector("svg")).toHaveAttribute("width", "16");
  expect(settingsButton).toHaveClass("home-side__workspace-action");
  expect(settingsButton).toHaveAttribute("title", "设置");
  expect(settingsButton.querySelector("svg")).toHaveAttribute("width", "18");
  fireEvent.click(switchButton);
  expect(actions.switchWorkspace).toHaveBeenCalledOnce();
  expect(actions.openSettings).not.toHaveBeenCalled();
  fireEvent.click(settingsButton);
  expect(actions.openSettings).toHaveBeenCalledOnce();
  expect(actions.switchWorkspace).toHaveBeenCalledOnce();
  rerender(<HomeWorkspaceActionsContext.Provider value={{ ...actions, workspaceName: "个人工作区" }}><HomeSidebarFooter /></HomeWorkspaceActionsContext.Provider>);
  expect(screen.getByRole("button", { name: "切换 Workspace" })).toHaveTextContent("个人工作区");
});

it("renders no footer or actions without workspace context", () => {
  const { container } = render(<HomeSidebarFooter />);
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole("group", { name: "工作区操作" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "切换 Workspace" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
});

const noteProps = { workspaceRoot: "/workspace", records: [], activeRecordId: 1,
  onOpenWorkspace: vi.fn(), onOpenRecord: vi.fn(), onCreateRecord: vi.fn() };
const sidebars = [
  { name: "project", content: ".project-navigation__modules", element: <HomeProjectSidebar
    projectId={1} projectName="Alpha" workspaceRoot="/workspace" project={{ id: 1, name: "Alpha", rootPath: "/project" }}
    documents={[]} records={[]} selectedTagId={null} onTagChange={vi.fn()}
    onOpenProject={vi.fn()} onOpenWorkspace={vi.fn()} onOpenRecord={vi.fn()} onCreateRecord={vi.fn()} /> },
  { name: "workspace note", content: ".home-side__scroll", element: <HomeNoteSidebar {...noteProps} /> },
  { name: "project note", content: ".home-side__split", element: <HomeNoteSidebar {...noteProps} projectId={1} filePanel={<div>文件</div>} /> },
  { name: "workspace overview", content: ".home-side__split", element: <WorkspaceOverviewSidebar
    workspaceRootPath="/workspace" projects={[]} archivedProjects={[]} records={[]} recordQuery=""
    onRecordQueryChange={vi.fn()} activeRecordTagId={null} onActiveRecordTagIdChange={vi.fn()}
    onOpenOverview={vi.fn()} onOpenProject={vi.fn()} onOpenProjectInNewWindow={vi.fn()}
    onCreateProject={vi.fn()} onOpenArchivedProject={vi.fn()} onRestoreArchivedProject={vi.fn()}
    onRenameProject={vi.fn()} onArchiveProject={vi.fn()} onDeleteProject={vi.fn()}
    onOpenRecord={vi.fn()} onCreateRecord={vi.fn()} /> },
];

it.each(sidebars)("places the $name footer immediately after its content as a direct sidebar child", ({ element, content }) => {
  withActions(element);
  const sidebar = screen.getByRole("complementary");
  const footer = within(sidebar).getByRole("group", { name: "工作区操作" });
  expect(footer.parentElement).toBe(sidebar);
  expect(footer.previousElementSibling).toBe(sidebar.querySelector(content));
  const brand = sidebar.querySelector<HTMLElement>(".home-side__brand")!;
  expect(brand.querySelector(".home-side__identity-title")).toHaveTextContent(sidebar.classList.contains("project-navigation") ? "Alpha" : "研究工作区");
  expect(within(brand).getByRole("img", { name: "NoriMind" })).toBeInTheDocument();
  expect(brand.querySelector(".home-side__identity-subtitle")).toHaveTextContent(sidebar.classList.contains("project-navigation") ? "·研究工作区" : "");
  expect(within(sidebar.querySelector<HTMLElement>(".home-side__brand")!).queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
});

it.each(sidebars)("hides the $name footer when collapsed and restores it when expanded", ({ element }) => {
  useUiStore.setState({ projectSidebarCollapsed: true });
  withActions(element);
  expect(screen.queryByRole("group", { name: "工作区操作" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "切换 Workspace" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^展开/ }));
  expect(screen.getByRole("group", { name: "工作区操作" })).toBeInTheDocument();
});
