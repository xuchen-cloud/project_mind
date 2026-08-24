import {
  fireEvent,
  render as baseRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useState } from "react";

import { createUiStoreState, useUiStore } from "../../state/ui-store";
import type { TodoRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { TodoRail } from "./TodoRail";

// TodoRail now uses useContactMentionOptions(), which needs a QueryClient.
function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

const todoWithHistory: TodoRecord = {
  id: 1,
  scope: "project",
  projectId: 1,
  activityId: 11,
  content: "Prepare demo notes",
  status: "unfinished",
  priority: "not_urgent_important",
  createdAt: "2026-04-06T08:00:00.000Z",
  updatedAt: "2026-04-06T10:00:00.000Z",
  progresses: [
    {
      id: 101,
      todoId: 1,
      content: "已同步法务",
      progressDate: "2026-04-06",
      createdAt: "2026-04-06T10:00:00.000Z",
      status: "unfinished",
      completedAt: null,
      orderIndex: 0,
    },
    {
      id: 102,
      todoId: 1,
      content: "等待财务确认",
      progressDate: "2026-04-05",
      createdAt: "2026-04-05T09:00:00.000Z",
      status: "finished",
      completedAt: "2026-04-05T09:30:00.000Z",
      orderIndex: 1,
    },
  ],
};

const anotherTodoWithHistory: TodoRecord = {
  ...todoWithHistory,
  id: 3,
  content: "Sync with finance",
  updatedAt: "2026-04-06T11:00:00.000Z",
  progresses: [
    {
      id: 103,
      todoId: 3,
      content: "已和税务对齐方案",
      progressDate: "2026-04-06",
      createdAt: "2026-04-06T11:00:00.000Z",
      status: "unfinished",
      completedAt: null,
      orderIndex: 0,
    },
    {
      id: 105,
      todoId: 3,
      content: "已收集财务问题",
      progressDate: "2026-04-05",
      createdAt: "2026-04-05T10:00:00.000Z",
      status: "finished",
      completedAt: "2026-04-05T10:30:00.000Z",
      orderIndex: 1,
    },
  ],
};

const todoWithoutHistory: TodoRecord = {
  ...todoWithHistory,
  id: 4,
  content: "No progress yet",
  updatedAt: "2026-04-06T07:00:00.000Z",
  progresses: [],
};

const finishedTodo: TodoRecord = {
  ...todoWithHistory,
  id: 2,
  status: "finished",
  content: "Done item",
  updatedAt: "2026-04-06T12:00:00.000Z",
  progresses: [
    {
      id: 104,
      todoId: 2,
      content: "已发出最终版本",
      progressDate: "2026-04-06",
      createdAt: "2026-04-06T12:00:00.000Z",
    },
  ],
};

describe("TodoRail", () => {
  function renderRail(
    partialProps: Partial<React.ComponentProps<typeof TodoRail>> = {},
  ) {
    return render(
      <TodoRail
        title="Todo List"
        scopeLabel="Alpha"
        unfinishedTodos={[todoWithoutHistory]}
        finishedTodos={[finishedTodo]}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={vi.fn()}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={vi.fn()}
        onDeleteProgress={vi.fn()}
        onDeleteTodo={vi.fn()}
        {...partialProps}
      />,
    );
  }

  async function selectOwnership(user: ReturnType<typeof userEvent.setup>, name: string) {
    const selector = screen.getByRole("combobox", { name: "Todo 归属" });
    await user.click(selector);
    const search = screen.getByRole("searchbox", { name: "筛选 Todo 归属" });
    await user.type(search, name);
    await user.click(screen.getByRole("option", { name }));
  }

  beforeEach(() => {
    installMemoryLocalStorage();
    useUiStore.setState(createUiStoreState());
  });

  it("selects and scrolls to the focused Todo in the correct Rail tab", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    useUiStore.setState({ todoRailCollapsed: true });
    renderRail({ focusTodoId: finishedTodo.id });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "返回未完成" })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" }),
    );
    expect(useUiStore.getState().todoRailCollapsed).toBe(false);
    expect(screen.getByText(finishedTodo.content).closest("[data-todo-id]")).toHaveClass(
      "is-focused",
    );
  });

  it("groups Workspace View and keeps flat Todo cards free of repeated Project names", async () => {
    const user = userEvent.setup();
    const workspaceTodo = {
      ...todoWithoutHistory,
      id: 20,
      scope: "workspace" as const,
      projectId: null,
      projectName: null,
      content: "Workspace action",
    };
    const betaTodo = {
      ...todoWithoutHistory,
      id: 21,
      projectId: 2,
      projectName: "Beta",
      content: "Beta action",
    };
    const olderBetaTodo = {
      ...betaTodo,
      id: 23,
      content: "Older Beta action",
      createdAt: "2026-04-05T08:00:00.000Z",
    };
    const alphaTodo = {
      ...todoWithoutHistory,
      id: 22,
      projectId: 1,
      projectName: "Alpha",
      content: "Alpha action",
    };

    renderRail({
      viewMode: "workspace",
      unfinishedTodos: [alphaTodo, olderBetaTodo, workspaceTodo, betaTodo],
      finishedTodos: [],
      createOwnershipOptions: [
        { projectId: 2, name: "Beta" },
        { projectId: 3, name: "Empty" },
        { projectId: 1, name: "Alpha" },
      ],
    });

    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["Workspace", "Beta", "Alpha"]);
    expect(screen.queryByRole("heading", { name: "Empty" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开 Project Beta" })).not.toBeInTheDocument();
    const betaGroup = screen.getByRole("heading", { name: "Beta" }).closest("section");
    expect(
      within(betaGroup!).getAllByText(/Beta action$/u).map((item) => item.textContent),
    ).toEqual(["Beta action", "Older Beta action"]);

    const groupToggle = screen.getByRole("button", { name: "分组显示" });
    expect(groupToggle).toHaveAttribute("aria-pressed", "true");
    expect(groupToggle.closest(".todo-rail__toolbar")).not.toBeNull();
    await user.click(groupToggle);
    expect(groupToggle).toHaveAttribute("aria-pressed", "false");

    expect(screen.queryByRole("button", { name: "打开 Project Beta" })).not.toBeInTheDocument();
    expect(useUiStore.getState().todoRailDisplayMode).toBe("flat");
  });

  it.each([
    ["beta", "Beta"],
    ["xiangmuhui", "项目会"],
    ["xmh", "项目会"],
  ])(
    "searches Todo ownership with %s while keeping Workspace fixed",
    async (query, projectName) => {
      const user = userEvent.setup();
      renderRail({
        viewMode: "workspace",
        finishedTodos: [],
        createOwnershipOptions: [
          { projectId: 7, name: "项目会" },
          { projectId: 8, name: "Beta" },
        ],
      });

      await user.click(screen.getByRole("button", { name: "新增代办" }));
      const ownershipSelector = screen.getByRole("combobox", { name: "Todo 归属" });
      await user.click(ownershipSelector);
      await user.type(screen.getByRole("searchbox", { name: "筛选 Todo 归属" }), query);

      expect(screen.getByRole("option", { name: "Workspace" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: projectName })).toBeInTheDocument();
      const hiddenProject = projectName === "Beta" ? "项目会" : "Beta";
      expect(screen.queryByRole("option", { name: hiddenProject })).not.toBeInTheDocument();

      await user.click(screen.getByRole("option", { name: projectName }));
      expect(ownershipSelector).toHaveTextContent(projectName);
    },
  );

  it("does not offer creation when the current Project is archived", () => {
    renderRail({ canCreateTodo: false, viewMode: "current-project" });

    expect(screen.getByRole("button", { name: "新增代办" })).toBeDisabled();
  });

  it("switches between Workspace View and Current Project View", async () => {
    const user = userEvent.setup();
    const onViewModeChange = vi.fn();
    renderRail({
      projectId: 1,
      viewMode: "current-project",
      showViewModeSwitch: true,
      onViewModeChange,
    });

    expect(screen.queryByText("Alpha", { selector: ".todo-rail__scope" })).not.toBeInTheDocument();
    const currentProjectTab = screen.getByRole("tab", { name: "当前项目" });
    const workspaceViewTab = screen.getByRole("tab", { name: "整个工作区" });
    expect(currentProjectTab).toHaveAttribute("aria-selected", "true");
    expect(workspaceViewTab).toHaveAttribute("aria-selected", "false");
    expect(workspaceViewTab.closest(".todo-rail__toolbar")).not.toBeNull();
    expect(workspaceViewTab.closest(".todo-rail__header")).toBeNull();
    await user.click(workspaceViewTab);
    expect(onViewModeChange).toHaveBeenCalledWith("workspace");
  });

  it("allows a Todo completion to be immediately undone while persistence is pending", async () => {
    const user = userEvent.setup();
    const onToggleStatus = vi.fn(() => new Promise<void>(() => undefined));

    renderRail({
      unfinishedTodos: [todoWithoutHistory],
      finishedTodos: [],
      onToggleStatus,
    });

    await user.click(screen.getByRole("button", { name: "标记为已完成" }));
    await user.click(screen.getByRole("button", { name: "标记为未完成" }));

    expect(onToggleStatus).toHaveBeenNthCalledWith(1, todoWithoutHistory.id, "finished");
    expect(onToggleStatus).toHaveBeenNthCalledWith(2, todoWithoutHistory.id, "unfinished");
  });

  it("persists the new todo draft on window blur", async () => {
    const user = userEvent.setup();

    renderRail({ projectId: 1, finishedTodos: [] });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(
      screen.getByPlaceholderText("写下一条需要推进的 Todo"),
      "锁屏前未提交的 Todo",
    );
    window.dispatchEvent(new Event("blur"));

    expect(
      JSON.parse(
        window.localStorage.getItem("project-mind:todo-rail-draft:1") ?? "{}",
      ),
    ).toMatchObject({
      content: "锁屏前未提交的 Todo",
      priority: "not_urgent_important",
    });
  });

  it("persists an explicitly selected Project before content is entered", async () => {
    const user = userEvent.setup();

    renderRail({
      createOwnershipOptions: [
        { projectId: 7, name: "Alpha" },
        { projectId: 8, name: "Beta" },
      ],
      finishedTodos: [],
    });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await selectOwnership(user, "Alpha");
    window.dispatchEvent(new Event("blur"));

    expect(
      JSON.parse(
        window.localStorage.getItem("project-mind:todo-rail-draft:workspace") ?? "{}",
      ),
    ).toMatchObject({
      content: "",
      priority: "not_urgent_important",
      projectId: 7,
    });
  });

  it("switches Tag and Internal Reference searches with composer ownership", async () => {
    const user = userEvent.setup();
    const referenceSearch = vi
      .spyOn(projectMindApi, "internalReferenceSearch")
      .mockResolvedValue([]);
    const tagSearch = vi
      .spyOn(projectMindApi, "projectTagSettingsGet")
      .mockResolvedValue({ tags: [] });

    renderRail({
      createOwnershipOptions: [
        { projectId: 7, name: "Alpha" },
        { projectId: 8, name: "Beta" },
      ],
      finishedTodos: [],
    });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    const composer = screen.getByPlaceholderText("写下一条需要推进的 Todo");
    fireEvent.change(composer, {
      target: { value: "[[budget", selectionStart: 8 },
    });
    fireEvent.select(composer, { target: { selectionStart: 8 } });
    await waitFor(() =>
      expect(referenceSearch).toHaveBeenCalledWith({
        query: "budget",
        projectId: null,
        scope: "workspace",
        limit: 8,
      }),
    );

    await selectOwnership(user, "Alpha");
    fireEvent.select(composer, { target: { selectionStart: 8 } });
    await waitFor(() =>
      expect(referenceSearch).toHaveBeenCalledWith({
        query: "budget",
        projectId: 7,
        scope: "project",
        limit: 8,
      }),
    );

    fireEvent.change(composer, {
      target: { value: "#同名", selectionStart: 3 },
    });
    fireEvent.select(composer, { target: { selectionStart: 3 } });
    await waitFor(() =>
      expect(tagSearch).toHaveBeenCalledWith({ projectId: 7 }),
    );

    await selectOwnership(user, "Beta");
    await user.clear(composer);
    await user.type(composer, "#另");
    await waitFor(() =>
      expect(tagSearch).toHaveBeenCalledWith({ projectId: 8 }),
    );
  });

  it("searches Workspace Internal References from the Workspace Todo creator", async () => {
    const user = userEvent.setup();
    const search = vi.spyOn(projectMindApi, "internalReferenceSearch").mockResolvedValue([]);

    renderRail({ finishedTodos: [] });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    const composer = screen.getByPlaceholderText("写下一条需要推进的 Todo");
    fireEvent.change(composer, {
      target: { value: "[[budget", selectionStart: 8 },
    });
    fireEvent.select(composer, {
      target: { selectionStart: 8 },
    });

    await waitFor(() =>
      expect(search).toHaveBeenCalledWith({
        query: "budget",
        projectId: null,
        scope: "workspace",
        limit: 8,
      }),
    );
  });

  it("restores Workspace composer content, priority, due date text, and Project ownership", async () => {
    window.localStorage.setItem(
      "project-mind:todo-rail-draft:workspace",
      JSON.stringify({
        content: "准备发布 @20260801",
        priority: "urgent_important",
        projectId: 7,
      }),
    );
    const onCreateTodo = vi.fn();

    renderRail({
      createOwnershipOptions: [{ projectId: 7, name: "Alpha" }],
      onCreateTodo,
    });

    expect(screen.getByRole("combobox", { name: "Todo 归属" })).toHaveTextContent("Alpha");
    expect(screen.getByRole("combobox", { name: "Todo 归属" })).toHaveClass(
      "todo-rail__ownership-select",
    );
    expect(
      screen.getByRole("combobox", { name: "Todo 归属" }).parentElement?.querySelector(
        ".todo-rail__ownership-chevron",
      ),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("写下一条需要推进的 Todo")).toHaveValue(
      "准备发布 @20260801",
    );
    expect(screen.getByTitle("P1 · 紧急且重要")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(onCreateTodo).toHaveBeenCalledWith({
      content: "准备发布",
      priority: "urgent_important",
      dueDate: "2026-08-01",
      projectId: 7,
    });
  });

  it("keeps an unavailable draft Project explicit and blocks submission", async () => {
    window.localStorage.setItem(
      "project-mind:todo-rail-draft:workspace",
      JSON.stringify({
        content: "不能静默改归属",
        priority: "not_urgent_important",
        projectId: 99,
      }),
    );
    const onCreateTodo = vi.fn();
    const onError = vi.fn();

    renderRail({
      createOwnershipOptions: [{ projectId: 7, name: "Alpha" }],
      onCreateTodo,
      onError,
    });

    expect(screen.getByRole("combobox", { name: "Todo 归属" })).toHaveTextContent(
      "Project 已不可用",
    );
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(onCreateTodo).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls the optional refresh handler from the header", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    renderRail({ onRefresh });

    await user.click(screen.getByRole("button", { name: "刷新代办列表" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables the refresh button while refreshing", () => {
    const onRefresh = vi.fn();

    renderRail({ onRefresh, refreshing: true });

    expect(screen.getByRole("button", { name: "刷新代办列表" })).toBeDisabled();
  });

  it("creates todos, auto-collapses expanded history on blur, and toggles collapse", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn();

    renderRail({
      unfinishedTodos: [todoWithHistory, anotherTodoWithHistory],
      onCreateTodo,
    });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(screen.getByPlaceholderText("写下一条需要推进的 Todo"), "Ship checklist");
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(onCreateTodo).toHaveBeenCalledWith({
      content: "Ship checklist",
      priority: "not_urgent_important",
    });

    const firstTodoRow = screen.getByText("Prepare demo notes").closest("article");
    const secondTodoRow = screen.getByText("Sync with finance").closest("article");

    await user.click(within(firstTodoRow!).getByRole("button", { name: "展开已完成子项" }));
    expect(screen.getAllByRole("button", { name: "收起已完成子项" })).toHaveLength(1);

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("button", { name: "收起已完成子项" })).not.toBeInTheDocument();

    await user.click(within(secondTodoRow!).getByRole("button", { name: "展开已完成子项" }));
    expect(screen.getAllByRole("button", { name: "收起已完成子项" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "收起代办侧边栏" }));
    expect(useUiStore.getState().todoRailCollapsed).toBe(true);
    expect(screen.getByRole("button", { name: "展开代办侧边栏" })).toBeInTheDocument();
  });

  it("creates a todo with an independent @ due date", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn();

    renderRail({ onCreateTodo });
    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(
      screen.getByPlaceholderText("写下一条需要推进的 Todo"),
      "@20270315 Ship checklist",
    );
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(onCreateTodo).toHaveBeenCalledWith({
      content: "Ship checklist",
      priority: "not_urgent_important",
      dueDate: "2027-03-15",
    });
  });

  it("hides expand without completed subitems and still toggles finished status", async () => {
    const user = userEvent.setup();
    const onToggleStatus = vi.fn();

    renderRail({ onToggleStatus });

    expect(screen.queryByRole("button", { name: "展开已完成子项" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /查看已完成/u }));
    expect(screen.getByText("Done item")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开已完成子项" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "标记为未完成" }));
    expect(onToggleStatus).toHaveBeenCalledWith(2, "unfinished");
  });

  it("keeps a transitioning todo rendered immediately after completion click", async () => {
    const user = userEvent.setup();
    const onToggleStatus = vi.fn(
      () => new Promise<void>((resolve) => window.setTimeout(resolve, 20)),
    );

    renderRail({
      unfinishedTodos: [todoWithHistory],
      finishedTodos: [],
      onToggleStatus,
    });

    await user.click(screen.getByRole("button", { name: "标记为已完成" }));

    expect(screen.getByText("Prepare demo notes")).toBeInTheDocument();
    expect(onToggleStatus).toHaveBeenCalledWith(1, "finished");
  });

  it("moves a completed Todo immediately when the optimistic parent update lands", async () => {
    const user = userEvent.setup();

    function TransitionHarness() {
      const [unfinishedTodos, setUnfinishedTodos] = useState([
        todoWithHistory,
        anotherTodoWithHistory,
      ]);
      const [finishedTodos, setFinishedTodos] = useState<TodoRecord[]>([]);

      return (
        <TodoRail
          title="Todo List"
          scopeLabel="Alpha"
          unfinishedTodos={unfinishedTodos}
          finishedTodos={finishedTodos}
          createPlaceholder="写下一条需要推进的 Todo"
          onCreateTodo={vi.fn()}
          onToggleStatus={async (todoId, status) => {
            const target = unfinishedTodos.find((todo) => todo.id === todoId);
            if (!target) {
              return;
            }

            if (status === "finished") {
              setUnfinishedTodos((current) => current.filter((todo) => todo.id !== todoId));
              setFinishedTodos((current) => [{ ...target, status: "finished" }, ...current]);
            } else {
              setFinishedTodos((current) => current.filter((todo) => todo.id !== todoId));
              setUnfinishedTodos((current) => [...current, { ...target, status: "unfinished" }]);
            }

            await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
          }}
          onUpdatePriority={vi.fn()}
          onUpdateContent={vi.fn()}
          onAddProgress={vi.fn()}
          onUpdateProgress={vi.fn()}
          onDeleteProgress={vi.fn()}
          onDeleteTodo={vi.fn()}
        />
      );
    }

    render(<TransitionHarness />);

    const targetCard = screen.getByText("Prepare demo notes").closest("article");
    await user.click(within(targetCard!).getByRole("button", { name: "标记为已完成" }));

    expect(screen.queryByText("Prepare demo notes")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /查看已完成/u }));
    expect(screen.getByText("Prepare demo notes")).toBeInTheDocument();
  });

  it("deletes a todo from the context menu", async () => {
    const user = userEvent.setup();
    const onDeleteTodo = vi.fn();

    renderRail({ finishedTodos: [], onDeleteTodo });

    fireEvent.contextMenu(document.getElementById("todo-4") as HTMLElement, {
      clientX: 140,
      clientY: 72,
    });

    await user.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(onDeleteTodo).toHaveBeenCalledWith(4);
  });

  it("updates todo priority from the context menu inline buttons", async () => {
    const user = userEvent.setup();
    const onUpdatePriority = vi.fn(async () => undefined);

    renderRail({ finishedTodos: [], onUpdatePriority });

    fireEvent.contextMenu(document.getElementById("todo-4") as HTMLElement, {
      clientX: 140,
      clientY: 72,
    });

    await user.click(screen.getByRole("button", { name: "P1 · 紧急且重要" }));

    expect(onUpdatePriority).toHaveBeenCalledWith(4, "urgent_important");
  });

  it("keeps completion history as a secondary footer action", async () => {
    const user = userEvent.setup();

    renderRail({
      unfinishedTodos: [todoWithHistory],
      finishedTodos: [finishedTodo],
    });

    expect(screen.getByRole("heading", { name: "Todo List" })).toBeInTheDocument();
    expect(screen.getByText("Alpha", { selector: ".todo-rail__scope" })).toBeInTheDocument();
    expect(screen.queryByText(/未完成 · .*已完成/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "P1" })).not.toBeInTheDocument();
    expect(screen.queryByText("全部标签")).not.toBeInTheDocument();
    expect(screen.queryByTestId("todo-rail-view-switch")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /查看已完成/u }));
    expect(screen.getByText("Done item")).toBeInTheDocument();
    expect(screen.getByText("已完成", { selector: ".todo-rail__finished-label" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回未完成" }));
    expect(screen.getByText("Prepare demo notes")).toBeInTheDocument();
  });

  it("keeps the selected tab and sort mode when the rail remounts", async () => {
    const user = userEvent.setup();
    const props = {
      unfinishedTodos: [todoWithHistory, anotherTodoWithHistory],
      finishedTodos: [
        finishedTodo,
        { ...finishedTodo, id: 5, content: "Another done item" },
      ],
    };

    const firstRail = renderRail(props);
    await user.click(screen.getByRole("tab", { name: "按优先级" }));
    await user.click(screen.getByRole("button", { name: /查看已完成/u }));

    firstRail.unmount();
    renderRail(props);

    expect(screen.getByRole("button", { name: "返回未完成" })).toBeInTheDocument();
    expect(screen.getByText("Done item")).toBeInTheDocument();
    expect(useUiStore.getState().todoRailSortMode).toBe("priority");
  });

  it("opens a compact focused composer with accessible priority dots", async () => {
    const user = userEvent.setup();

    renderRail({ finishedTodos: [] });

    await user.click(screen.getByRole("button", { name: "新增代办" }));

    const composer = screen.getByPlaceholderText("写下一条需要推进的 Todo");
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer).toHaveAttribute("rows", "1");
    expect(composer).toHaveClass("todo-editor-field", "resize-none");
    expect(screen.queryByText(/Cmd|Ctrl|Enter.*保存/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "P1 · 紧急且重要" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "P3 · 不紧急但重要" })).toHaveAttribute("aria-pressed", "true");
  });

  it("builds a Todo card draft with a live priority rail, Tags, and Subtasks", async () => {
    const user = userEvent.setup();
    const tag = {
      id: 12,
      label: "法务",
      colorKey: "red" as const,
      usageCount: 0,
      createdAt: "2026-04-06T08:00:00.000Z",
      updatedAt: "2026-04-06T08:00:00.000Z",
    };
    const createdTodo = {
      ...todoWithoutHistory,
      id: 88,
      content: "准备发布",
      tags: [{ id: tag.id, label: tag.label, colorKey: tag.colorKey }],
    };
    const onCreateTodo = vi.fn(async () => createdTodo);
    const onAddProgress = vi.fn(async () => undefined);

    renderRail({
      finishedTodos: [],
      availableTags: [tag],
      onCreateTodo,
      onAddProgress,
    });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    const card = screen.getByTestId("todo-composer-card");
    expect(card.querySelector(".todo-rail__composer-priority-rail")).toBeInTheDocument();
    expect(card).toHaveStyle({ "--todo-priority-color": "var(--color-todo-p3)" });
    await user.click(within(card).getByRole("button", { name: "P1 · 紧急且重要" }));
    expect(card).toHaveStyle({ "--todo-priority-color": "var(--color-todo-p1)" });

    await user.type(within(card).getByPlaceholderText("写下一条需要推进的 Todo"), "准备发布");
    expect(card.querySelector(".todo-rail__composer-primary > .todo-rail__composer-priority-rail"))
      .toBeInTheDocument();
    expect(card.querySelector(".todo-rail__composer-subtasks .todo-rail__composer-priority-rail"))
      .not.toBeInTheDocument();
    const tagInput = within(card).getByPlaceholderText("# 新增标签");
    expect(tagInput.closest("label")?.querySelector("svg")).toBeNull();
    await user.type(tagInput, "法务{Enter}");

    await user.click(within(card).getByRole("button", { name: "添加子任务" }));
    const subtaskEditor = card.querySelector(
      ".todo-subtask-editor [role=\"textbox\"]",
    ) as HTMLElement;
    expect(subtaskEditor).toBeInTheDocument();
    await user.type(subtaskEditor, "@0315 准备资料");
    await user.keyboard("{Enter}");
    expect(within(card).getByText("准备资料")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "创建" }));

    expect(onCreateTodo).toHaveBeenCalledWith({
      content: "准备发布",
      priority: "urgent_important",
      tagIds: [tag.id],
      optimisticTags: [{ id: tag.id, label: tag.label, colorKey: tag.colorKey }],
    });
    expect(onAddProgress).toHaveBeenCalledWith(
      createdTodo.id,
      expect.objectContaining({ content: "准备资料" }),
    );
  });

  it("waits for a newly created Tag before enabling Todo creation", async () => {
    const user = userEvent.setup();
    const createdTag = {
      id: 23,
      label: "新标签",
      colorKey: "blue" as const,
      usageCount: 0,
      createdAt: "2026-08-23T08:00:00.000Z",
      updatedAt: "2026-08-23T08:00:00.000Z",
    };
    let resolveTag!: (tag: typeof createdTag) => void;
    const tagCreate = vi
      .spyOn(projectMindApi, "projectTagUpsert")
      .mockImplementation(() => new Promise((resolve) => { resolveTag = resolve; }));
    const onCreateTodo = vi.fn(async () => ({ ...todoWithoutHistory, id: 89 }));

    renderRail({ finishedTodos: [], onCreateTodo });
    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(screen.getByPlaceholderText("写下一条需要推进的 Todo"), "带新标签创建");
    const tagInput = screen.getByPlaceholderText("# 新增标签");
    await user.type(tagInput, "新标签{Enter}");

    await waitFor(() => expect(screen.getByRole("button", { name: "创建" })).toBeDisabled());
    expect(onCreateTodo).not.toHaveBeenCalled();

    resolveTag(createdTag);
    await waitFor(() => expect(screen.getByLabelText("移除标签 新标签")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(onCreateTodo).toHaveBeenCalledWith({
      content: "带新标签创建",
      priority: "not_urgent_important",
      tagIds: [createdTag.id],
      optimisticTags: [
        { id: createdTag.id, label: createdTag.label, colorKey: createdTag.colorKey },
      ],
    });
    tagCreate.mockRestore();
  });

  it("commits a typed new Tag before the Create button submits the Todo", async () => {
    const user = userEvent.setup();
    const createdTag = {
      id: 25,
      label: "直接创建",
      colorKey: "teal" as const,
      usageCount: 0,
      createdAt: "2026-08-23T08:00:00.000Z",
      updatedAt: "2026-08-23T08:00:00.000Z",
    };
    const tagCreate = vi
      .spyOn(projectMindApi, "projectTagUpsert")
      .mockResolvedValue(createdTag);
    const onCreateTodo = vi.fn(async () => ({ ...todoWithoutHistory, id: 90 }));

    renderRail({ finishedTodos: [], onCreateTodo });
    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(screen.getByPlaceholderText("写下一条需要推进的 Todo"), "带标签创建");
    await user.type(screen.getByPlaceholderText("# 新增标签"), "直接创建");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(onCreateTodo).toHaveBeenCalledWith({
        content: "带标签创建",
        priority: "not_urgent_important",
        tagIds: [createdTag.id],
        optimisticTags: [
          { id: createdTag.id, label: createdTag.label, colorKey: createdTag.colorKey },
        ],
      }),
    );
    tagCreate.mockRestore();
  });

  it("commits a blurred new Tag before an outside click submits the Todo", async () => {
    const user = userEvent.setup();
    const createdTag = {
      id: 24,
      label: "外点标签",
      colorKey: "green" as const,
      usageCount: 0,
      createdAt: "2026-08-23T08:00:00.000Z",
      updatedAt: "2026-08-23T08:00:00.000Z",
    };
    let resolveTag!: (tag: typeof createdTag) => void;
    const tagCreate = vi
      .spyOn(projectMindApi, "projectTagUpsert")
      .mockImplementation(() => new Promise((resolve) => { resolveTag = resolve; }));
    const onCreateTodo = vi.fn(async () => ({ ...todoWithoutHistory, id: 91 }));
    const outsideAction = vi.fn();

    render(
      <>
        <button type="button" onClick={outsideAction}>继续工作</button>
        <TodoRail
          title="Todo List"
          scopeLabel="Alpha"
          unfinishedTodos={[]}
          finishedTodos={[]}
          createPlaceholder="写下一条需要推进的 Todo"
          onCreateTodo={onCreateTodo}
          onToggleStatus={vi.fn()}
          onUpdatePriority={vi.fn()}
          onUpdateContent={vi.fn()}
          onAddProgress={vi.fn()}
          onUpdateProgress={vi.fn()}
          onDeleteProgress={vi.fn()}
          onDeleteTodo={vi.fn()}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(screen.getByPlaceholderText("写下一条需要推进的 Todo"), "外点创建");
    await user.type(screen.getByPlaceholderText("# 新增标签"), "外点标签");
    await user.click(screen.getByRole("button", { name: "继续工作" }));

    expect(outsideAction).toHaveBeenCalledTimes(1);
    expect(onCreateTodo).not.toHaveBeenCalled();
    resolveTag(createdTag);
    await waitFor(() =>
      expect(onCreateTodo).toHaveBeenCalledWith({
        content: "外点创建",
        priority: "not_urgent_important",
        tagIds: [createdTag.id],
        optimisticTags: [
          { id: createdTag.id, label: createdTag.label, colorKey: createdTag.colorKey },
        ],
      }),
    );
    tagCreate.mockRestore();
  });

  it("lets nested Tag and Subtask editors handle Escape without discarding the Todo draft", async () => {
    const user = userEvent.setup();
    renderRail({ finishedTodos: [] });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(screen.getByPlaceholderText("写下一条需要推进的 Todo"), "保留创建草稿");
    await user.click(
      within(screen.getByTestId("todo-composer-card")).getByRole("button", {
        name: "添加子任务",
      }),
    );
    const subtaskEditor = document.querySelector(
      ".todo-subtask-editor [role=\"textbox\"]",
    ) as HTMLElement;
    await user.type(subtaskEditor, "暂不添加");
    await user.keyboard("{Escape}");

    expect(screen.getByTestId("todo-composer-card")).toBeInTheDocument();
    expect(document.querySelector(".todo-subtask-editor [role=\"textbox\"]")).toBeNull();

    const tagInput = screen.getByPlaceholderText("# 新增标签");
    await user.type(tagInput, "暂不选择");
    await user.keyboard("{Escape}");

    expect(screen.getByTestId("todo-composer-card")).toBeInTheDocument();
    expect(tagInput).toHaveValue("");
    expect(screen.getByPlaceholderText("写下一条需要推进的 Todo")).toHaveValue("保留创建草稿");
  });

  it("blocks ownership changes while a Subtask contains a scoped Internal Reference", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    window.localStorage.setItem(
      "project-mind:todo-rail-draft:workspace",
      JSON.stringify({
        content: "保留引用作用域",
        priority: "not_urgent_important",
        projectId: null,
        subtasks: [
          {
            content: "核对 [[todo:1|原范围 Todo]]",
            progressDate: "2026-08-23",
          },
        ],
      }),
    );

    renderRail({
      finishedTodos: [],
      createOwnershipOptions: [{ projectId: 7, name: "Alpha" }],
      onError,
    });
    await selectOwnership(user, "Alpha");

    expect(screen.getByRole("combobox", { name: "Todo 归属" })).toHaveTextContent("Workspace");
    expect(onError).toHaveBeenCalledWith(
      "请先移除 Todo 与 Subtask 中的 Internal Reference，再切换归属。",
    );
    expect(screen.getByText(/核对/u)).toBeInTheDocument();
  });

  it("preserves ambiguous Subtask failures without retrying or creating a duplicate Todo", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "project-mind:todo-rail-draft:workspace",
      JSON.stringify({
        content: "分步发布",
        priority: "not_urgent_important",
        projectId: null,
        tagIds: [],
        subtasks: [
          { content: "第一步", progressDate: "2026-08-23" },
          { content: "第二步", progressDate: "2026-08-24" },
        ],
      }),
    );
    const onCreateTodo = vi.fn(async () => ({ ...todoWithoutHistory, id: 90 }));
    const onAddProgress = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("响应丢失"));
    const onError = vi.fn();
    const onRefresh = vi.fn(async () => undefined);

    renderRail({ finishedTodos: [], onCreateTodo, onAddProgress, onError, onRefresh });
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "Todo 已创建；仍有 1 个 Subtask 草稿需核对后手动添加：Error: 响应丢失；Todo 列表已刷新，请核对。",
      ),
    );
    expect(onCreateTodo).toHaveBeenCalledTimes(1);
    expect(onAddProgress.mock.calls).toEqual([
      [90, expect.objectContaining({ content: "第一步" })],
      [90, expect.objectContaining({ content: "第二步" })],
    ]);
    expect(screen.queryByText("第一步")).not.toBeInTheDocument();
    expect(screen.getByText("第二步")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("仍有 1 个 Subtask 草稿需核对");
    expect(screen.getByRole("button", { name: "Todo 已创建" })).toBeDisabled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onCreateTodo).toHaveBeenCalledTimes(1);
    expect(onAddProgress).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "已核对，清除草稿" }));
    expect(screen.queryByTestId("todo-composer-card")).not.toBeInTheDocument();
  });

  it("auto-grows the content field through six lines before enabling internal scrolling", async () => {
    const user = userEvent.setup();
    renderRail({ finishedTodos: [] });
    await user.click(screen.getByRole("button", { name: "新增代办" }));
    const composer = screen.getByPlaceholderText("写下一条需要推进的 Todo");
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 999 });

    fireEvent.change(composer, { target: { value: "1\n2\n3\n4\n5\n6\n7" } });

    expect(composer).toHaveAttribute("data-max-lines", "6");
    expect(composer).toHaveStyle({ overflowY: "auto" });
    expect((composer as HTMLTextAreaElement).style.height).toBe(
      (composer as HTMLTextAreaElement).style.maxHeight,
    );
  });

  it("treats creator-owned Project, Contact Mention, Tag, and Internal Reference panels as inside", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn(async () => undefined);
    renderRail({
      finishedTodos: [],
      onCreateTodo,
      createOwnershipOptions: [{ projectId: 7, name: "Alpha" }],
    });
    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(screen.getByPlaceholderText("写下一条需要推进的 Todo"), "不应意外提交");

    const panelSelectors = [
      "contact-mention-picker",
      "tag-mention-picker",
      "internal-reference-picker",
    ];
    for (const className of panelSelectors) {
      const panel = document.createElement("div");
      panel.className = className;
      document.body.append(panel);
      fireEvent.pointerDown(panel);
      panel.remove();
    }
    await user.click(screen.getByRole("combobox", { name: "Todo 归属" }));
    fireEvent.pointerDown(screen.getByRole("option", { name: "Workspace" }));

    expect(onCreateTodo).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("写下一条需要推进的 Todo")).toHaveValue("不应意外提交");
  });

  it("creates on Enter, keeps Shift+Enter as a newline, and ignores IME composition Enter", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn(async () => undefined);
    renderRail({ finishedTodos: [], onCreateTodo });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    const composer = screen.getByPlaceholderText("写下一条需要推进的 Todo");
    await user.type(composer, "第一行");
    await user.keyboard("{Shift>}{Enter}{/Shift}第二行");
    expect(composer).toHaveValue("第一行\n第二行");

    fireEvent.compositionStart(composer);
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(composer);
    expect(onCreateTodo).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onCreateTodo).toHaveBeenCalledWith({
      content: "第一行\n第二行",
      priority: "not_urgent_important",
    });
  });

  it("discards the complete draft on Escape and restores focus to the add control", async () => {
    const user = userEvent.setup();
    renderRail({ finishedTodos: [] });

    const addButton = screen.getByRole("button", { name: "新增代办" });
    await user.click(addButton);
    const composer = screen.getByPlaceholderText("写下一条需要推进的 Todo");
    await user.type(composer, "稍后不保留");
    await user.click(screen.getByRole("button", { name: "P1 · 紧急且重要" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByPlaceholderText("写下一条需要推进的 Todo")).not.toBeInTheDocument();
    await waitFor(() => expect(addButton).toHaveFocus());
    expect(window.localStorage.getItem("project-mind:todo-rail-draft:workspace")).toBeNull();
  });

  it("discards an empty outside click and creates a non-empty draft without blocking its target", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn(async () => undefined);
    const outsideAction = vi.fn();
    render(
      <>
        <button type="button" onClick={outsideAction}>下一步</button>
        <TodoRail
          title="Todo List"
          scopeLabel="Alpha"
          unfinishedTodos={[]}
          finishedTodos={[]}
          createPlaceholder="写下一条需要推进的 Todo"
          onCreateTodo={onCreateTodo}
          onToggleStatus={vi.fn()}
          onUpdatePriority={vi.fn()}
          onUpdateContent={vi.fn()}
          onAddProgress={vi.fn()}
          onUpdateProgress={vi.fn()}
          onDeleteProgress={vi.fn()}
          onDeleteTodo={vi.fn()}
        />
      </>,
    );

    const addButton = screen.getByRole("button", { name: "新增代办" });
    await user.click(addButton);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(onCreateTodo).not.toHaveBeenCalled();
    expect(outsideAction).toHaveBeenCalledTimes(1);

    await user.click(addButton);
    await user.type(screen.getByPlaceholderText("写下一条需要推进的 Todo"), "自然提交");
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(onCreateTodo).toHaveBeenCalledWith({
      content: "自然提交",
      priority: "not_urgent_important",
    });
    expect(outsideAction).toHaveBeenCalledTimes(2);
  });

  it("locks the complete composer and ignores Escape and outside clicks while pending", async () => {
    const user = userEvent.setup();
    let resolveCreate!: () => void;
    const onCreateTodo = vi.fn(() => new Promise<void>((resolve) => { resolveCreate = resolve; }));
    renderRail({ finishedTodos: [], onCreateTodo });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    const composer = screen.getByPlaceholderText("写下一条需要推进的 Todo");
    fireEvent.change(composer, {
      target: { value: "等待 [[bud", selectionStart: 8 },
    });
    fireEvent.select(composer, { target: { selectionStart: 8 } });
    await waitFor(() =>
      expect(document.querySelector(".internal-reference-picker")).not.toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(screen.getByRole("button", { name: "创建中…" })).toBeDisabled();
    expect(composer).toBeDisabled();
    expect(screen.getByRole("button", { name: "P1 · 紧急且重要" })).toBeDisabled();
    expect(document.querySelector(".internal-reference-picker")).toBeNull();
    fireEvent.keyDown(composer, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(composer).toBeInTheDocument();

    resolveCreate();
    await waitFor(() => expect(composer).not.toBeInTheDocument());
  });

  it("locks the draft for manual verification when the Todo creation result is unknown", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const onRefresh = vi.fn(async () => undefined);
    renderRail({
      finishedTodos: [],
      onCreateTodo: vi.fn().mockRejectedValue(new Error("Internal Reference 不兼容")),
      onError,
      onRefresh,
    });

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    const composer = screen.getByPlaceholderText("写下一条需要推进的 Todo");
    fireEvent.change(composer, { target: { value: "保留 [[todo:99|引用]]" } });
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(composer).toHaveValue("保留 [[todo:99|引用]]");
    expect(onError).toHaveBeenCalledWith(
      "Todo 创建结果无法确认，草稿已保留：Error: Internal Reference 不兼容；Todo 列表已刷新，请核对。",
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "请先核对" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Todo 创建结果无法确认");
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("todo-composer-card")).toBeInTheDocument();
    expect(
      JSON.parse(
        window.localStorage.getItem("project-mind:todo-rail-draft:workspace") ?? "{}",
      ),
    ).toMatchObject({ creationOutcome: "unknown" });

    await user.click(screen.getByRole("button", { name: "确认未创建，继续编辑" }));
    expect(screen.getByRole("button", { name: "创建" })).toBeEnabled();
    expect(composer).toBeEnabled();
    expect(
      JSON.parse(
        window.localStorage.getItem("project-mind:todo-rail-draft:workspace") ?? "{}",
      ),
    ).toMatchObject({ creationOutcome: null });
  });

  it("updates a completed sub item from its context menu", async () => {
    const user = userEvent.setup();
    const onUpdateProgress = vi.fn();

    renderRail({
      unfinishedTodos: [todoWithHistory],
      finishedTodos: [],
      onUpdateProgress,
    });

    await user.click(screen.getByRole("button", { name: "展开已完成子项" }));
    fireEvent.contextMenu(screen.getByText("等待财务确认").closest("article") as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "编辑子项" }));

    expect(document.querySelector(".todo-card__expand--hidden")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    const textbox = screen.getByRole("textbox");
    await user.clear(textbox);
    await user.type(textbox, "已完成财务确认");
    await user.keyboard("{Enter}");

    expect(onUpdateProgress).toHaveBeenCalledWith(102, {
      content: "已完成财务确认",
      progressDate: "2026-04-05",
      status: "finished",
    });
  });


  it("deletes a completed sub item from its context menu", async () => {
    const user = userEvent.setup();
    const onDeleteProgress = vi.fn();

    renderRail({
      unfinishedTodos: [todoWithHistory],
      finishedTodos: [],
      onDeleteProgress,
    });

    await user.click(screen.getByRole("button", { name: "展开已完成子项" }));
    fireEvent.contextMenu(screen.getByText("等待财务确认").closest("article") as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "删除子项" }));

    expect(onDeleteProgress).toHaveBeenCalledWith(102);
  });

  it("deletes a sub item from the finished tab context menu even when inline editing is disabled", async () => {
    const user = userEvent.setup();
    const onDeleteProgress = vi.fn();

    renderRail({
      unfinishedTodos: [],
      finishedTodos: [{ ...todoWithHistory, id: 9, status: "finished" }],
      onDeleteProgress,
    });

    await user.click(screen.getByRole("button", { name: /查看已完成/u }));
    fireEvent.contextMenu(screen.getByText("已同步法务").closest("article") as HTMLElement);

    expect(screen.queryByRole("menuitem", { name: "编辑子项" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "删除子项" }));

    expect(onDeleteProgress).toHaveBeenCalledWith(101);
  });
});

function installMemoryLocalStorage() {
  const entries = new Map<string, string>();

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
      clear: () => entries.clear(),
    },
  });
}
