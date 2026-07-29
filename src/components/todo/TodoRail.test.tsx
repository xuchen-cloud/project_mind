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
      expect(screen.getByRole("button", { name: "已完成" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
    expect(useUiStore.getState().todoRailCollapsed).toBe(false);
    expect(screen.getByText(finishedTodo.content)).toBeInTheDocument();
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Todo 归属" }), "7");
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

    await user.selectOptions(screen.getByRole("combobox", { name: "Todo 归属" }), "7");
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

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Todo 归属" }),
      "8",
    );
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

    expect(screen.getByRole("combobox", { name: "Todo 归属" })).toHaveValue("7");
    expect(screen.getByPlaceholderText("写下一条需要推进的 Todo")).toHaveValue(
      "准备发布 @20260801",
    );
    expect(screen.getByTitle("P1 · 紧急且重要")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "保存" }));
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

    expect(screen.getByRole("combobox", { name: "Todo 归属" })).toHaveValue("99");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onCreateTodo).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("所选 Project 已不可用，请重新选择归属。");
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
    await user.click(screen.getByRole("button", { name: "保存" }));
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
    await user.click(screen.getByRole("button", { name: "保存" }));

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

    await user.click(screen.getByRole("button", { name: "已完成" }));
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

  it("keeps a completing todo in its original position while it fades out", async () => {
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

    const getVisibleTitles = () =>
      Array.from(document.querySelectorAll(".todo-list__collection > article")).map((article) =>
        article.querySelector(".todo-inline-content")?.textContent?.trim() ?? "",
      );

    const initialTitles = getVisibleTitles();
    const originalIndex = initialTitles.indexOf("Prepare demo notes");

    expect(originalIndex).toBeGreaterThanOrEqual(0);

    const targetCard = screen.getByText("Prepare demo notes").closest("article");
    await user.click(within(targetCard!).getByRole("button", { name: "标记为已完成" }));

    const transitionedTitles = getVisibleTitles();

    expect(transitionedTitles[originalIndex]).toBe("Prepare demo notes");
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

  it("renders a simplified header and keeps unfinished/finished tab switching", async () => {
    const user = userEvent.setup();

    renderRail({
      unfinishedTodos: [todoWithHistory],
      finishedTodos: [finishedTodo],
    });

    expect(screen.getByRole("heading", { name: "Todo List" })).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.queryByText(/未完成 · .*已完成/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "P1" })).not.toBeInTheDocument();
    expect(screen.queryByText("全部标签")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "已完成" }));
    expect(screen.getByText("Done item")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "未完成" }));
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
    await user.click(screen.getByRole("button", { name: "按优先级" }));
    await user.click(screen.getByRole("button", { name: "已完成" }));

    firstRail.unmount();
    renderRail(props);

    expect(screen.getByRole("button", { name: "已完成" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Done item")).toBeInTheDocument();
    expect(useUiStore.getState().todoRailSortMode).toBe("priority");
  });

  it("renders the composer with shortcut hint and save action", async () => {
    const user = userEvent.setup();

    renderRail({ finishedTodos: [] });

    await user.click(screen.getByRole("button", { name: "新增代办" }));

    expect(screen.getByText("Cmd/Ctrl + Enter 保存")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "已完成" }));
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
