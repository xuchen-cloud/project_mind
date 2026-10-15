import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { queryKeys } from "../../lib/queryKeys";
import type { TodoRecord } from "../../lib/types";
import { WorkspaceTodoRail } from "./WorkspaceTodoRail";

const apiMocks = vi.hoisted(() => ({
  projectsList: vi.fn(),
  projectPageGet: vi.fn(),
  workspacePageGet: vi.fn(),
  projectTagSettingsGet: vi.fn(),
  todoCreate: vi.fn(),
  projectTagUpsert: vi.fn(),
  internalReferenceResolve: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({ projectMindApi: apiMocks }));

const project = {
  id: 1, name: "Alpha", rootPath: "/tmp/alpha", isArchived: false,
  kind: "normal" as const, quickNote: "", status: "active",
  openTodoCount: 0, createdAt: "", updatedAt: "",
};

function LocationDisplay() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}</output>;
}

function renderRail(projectId: number | null, visible = true, search = "") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (nextVisible: boolean) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`${projectId === null ? "/workspace" : `/projects/${projectId}`}${search}`]}>
        <WorkspaceTodoRail projectId={projectId} visible={nextVisible} />
        <LocationDisplay />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(content(visible)), queryClient, content };
}

describe("WorkspaceTodoRail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    useUiStore.setState(createUiStoreState());
    apiMocks.projectsList.mockResolvedValue([project]);
    apiMocks.projectPageGet.mockResolvedValue({ project, records: [], unfinishedTodos: [], finishedTodos: [] });
    apiMocks.workspacePageGet.mockResolvedValue({ quickNote: null, records: [], unfinishedTodos: [], finishedTodos: [] });
    apiMocks.projectTagSettingsGet.mockResolvedValue({ tags: [] });
    apiMocks.todoCreate.mockImplementation(async (input) => ({
      ...todo, ...input, id: 99, revision: 1, projectId: input.projectId ?? null,
    }));
  });

  it("defaults to Current Project View and persists a switch to Workspace View", async () => {
    const user = userEvent.setup();
    renderRail(1);

    const viewMode = screen.getByRole("combobox", { name: "待办范围" });
    expect(viewMode).toHaveValue("current-project");
    await user.selectOptions(viewMode, "workspace");

    expect(useUiStore.getState().projectTodoViewMode).toBe("workspace");
    expect(viewMode).toHaveValue("workspace");
    await user.selectOptions(viewMode, "current-project");
    expect(useUiStore.getState().projectTodoViewMode).toBe("current-project");
  });

  it.each([null, 1])("pauses Todo and metadata queries while hidden (projectId=%s)", async (projectId) => {
    const view = renderRail(projectId, false);
    await act(async () => { await view.queryClient.invalidateQueries(); });
    expect(apiMocks.projectsList).not.toHaveBeenCalled();
    expect(apiMocks.projectTagSettingsGet).not.toHaveBeenCalled();
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();

    view.rerender(view.content(true));
    await waitFor(() => {
      expect(apiMocks.projectTagSettingsGet).toHaveBeenCalled();
      expect(projectId === null ? apiMocks.workspacePageGet : apiMocks.projectPageGet).toHaveBeenCalled();
      expect(view.queryClient.isFetching()).toBe(0);
    });

    view.rerender(view.content(false));
    vi.clearAllMocks();
    await act(async () => { await view.queryClient.invalidateQueries(); });
    expect(apiMocks.projectsList).not.toHaveBeenCalled();
    expect(apiMocks.projectTagSettingsGet).not.toHaveBeenCalled();
    expect(apiMocks.workspacePageGet).not.toHaveBeenCalled();
    expect(apiMocks.projectPageGet).not.toHaveBeenCalled();
  });

  it("disables Current Project creation on Archive while keeping Workspace creation available", async () => {
    const user = userEvent.setup();
    const view = renderRail(1);
    const createButton = screen.getByRole("button", { name: "新增代办" });
    await waitFor(() => expect(createButton).toBeEnabled());

    act(() => view.queryClient.setQueryData(queryKeys.projects.all, [{ ...project, isArchived: true }]));
    await waitFor(() => expect(createButton).toBeDisabled());
    await user.selectOptions(screen.getByRole("combobox", { name: "待办范围" }), "workspace");
    expect(createButton).toBeEnabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "待办范围" }), "current-project");
    expect(createButton).toBeDisabled();
  });

  it("uses the selected scope's existing tags when creating Todos", async () => {
    const user = userEvent.setup();
    apiMocks.projectTagSettingsGet.mockImplementation(async (input) => ({
      tags: [{
        id: input.projectId === 1 ? 31 : 41, label: "预算", colorKey: "amber",
        usageCount: 0, createdAt: "", updatedAt: "",
      }],
    }));
    renderRail(1);
    const createButton = screen.getByRole("button", { name: "新增代办" });
    await waitFor(() => expect(createButton).toBeEnabled());
    await user.click(createButton);
    await user.type(screen.getByPlaceholderText("写下要做的事"), "核对项目 #预算");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(apiMocks.todoCreate).toHaveBeenCalledWith(expect.objectContaining({
      scope: "project", projectId: 1, content: "核对项目", tagIds: [31],
    })));

    await user.selectOptions(screen.getByRole("combobox", { name: "待办范围" }), "workspace");
    await user.click(createButton);
    await user.type(screen.getByPlaceholderText("写下要做的事"), "核对工作区 #预算");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(apiMocks.todoCreate).toHaveBeenCalledWith(expect.objectContaining({
      scope: "workspace", projectId: null, content: "核对工作区", tagIds: [41],
    })));
    expect(apiMocks.projectTagUpsert).not.toHaveBeenCalled();
  });

  it("focuses a completed Todo from the URL search", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    apiMocks.projectPageGet.mockResolvedValue({
      project, records: [], unfinishedTodos: [], finishedTodos: [{ ...todo, status: "finished" }],
    });
    renderRail(1, true, "?focus=todo-7");

    expect(await screen.findByRole("heading", { name: "已完成", exact: true })).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById("todo-7")).toHaveClass("is-focused"));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("opens Todo internal references and contact mentions through the navigation hooks", async () => {
    const user = userEvent.setup();
    apiMocks.projectPageGet.mockResolvedValue({
      project, records: [], finishedTodos: [],
      unfinishedTodos: [{ ...todo, content: "查看 [[note:9|来源记录]] @[contact:3|小陈]" }],
    });
    apiMocks.internalReferenceResolve.mockResolvedValue({ kind: "note", id: 9, route: "/projects/1/records/9" });
    renderRail(1);

    await user.click(await screen.findByRole("link", { name: /来源记录/ }));
    await waitFor(() => expect(screen.getByLabelText("当前位置")).toHaveTextContent("/projects/1/records/9"));
    await user.click(screen.getByRole("link", { name: /小陈/ }));
    expect(useUiStore.getState().settingsSection).toBe("contacts");
  });
});

const todo: TodoRecord = {
  id: 7, revision: 1, scope: "project", projectId: 1, content: "推进 Alpha",
  status: "unfinished", priority: "not_urgent_important", tags: [], progresses: [],
  createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z",
};
