import { fireEvent, render as baseRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { useUiStore } from "../../state/ui-store";
import type { TodoRecord } from "../../lib/types";
import { TodoRail } from "./TodoRail";

// TodoRail now uses useContactMentionOptions(), which needs a QueryClient.
function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

const todoWithHistory: TodoRecord = {
  id: 1,
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
  beforeEach(() => {
    installMemoryLocalStorage();
    useUiStore.setState({
      createProjectOpen: false,
      createActivityOpen: false,
      projectComposer: null,
      projectSidebarCollapsed: false,
      todoRailCollapsed: false,
    });
  });

  it("persists the new todo draft on window blur", async () => {
    const user = userEvent.setup();

    render(
      <TodoRail
        projectId={1}
        title="项目待办"
        scopeLabel="Alpha"
        unfinishedTodos={[todoWithoutHistory]}
        finishedTodos={[]}
        activityNameById={new Map([[11, "Kickoff"]])}
        activityOptions={[{ id: 11, title: "Kickoff" }]}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={vi.fn()}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onUpdateActivity={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={vi.fn()}
        onDeleteProgress={vi.fn()}
        onDeleteTodo={vi.fn()}
        onOpenTodoSource={vi.fn()}
      />,
    );

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

  it("creates todos, auto-collapses expanded history on blur, and toggles collapse", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn();

    render(
      <TodoRail
        title="项目待办"
        scopeLabel="Alpha"
        unfinishedTodos={[todoWithHistory, anotherTodoWithHistory]}
        finishedTodos={[finishedTodo]}
        activityNameById={new Map([[11, "Kickoff"]])}
        activityOptions={[{ id: 11, title: "Kickoff" }]}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={onCreateTodo}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onUpdateActivity={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={vi.fn()}
        onDeleteProgress={vi.fn()}
        onDeleteTodo={vi.fn()}
        onOpenTodoSource={vi.fn()}
      />,
    );

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

  it("disables expand without history and still toggles finished status", async () => {
    const user = userEvent.setup();
    const onToggleStatus = vi.fn();

    render(
      <TodoRail
        title="项目待办"
        scopeLabel="Alpha"
        unfinishedTodos={[todoWithoutHistory]}
        finishedTodos={[finishedTodo]}
        activityNameById={new Map([[11, "Kickoff"]])}
        activityOptions={[{ id: 11, title: "Kickoff" }]}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={vi.fn()}
        onToggleStatus={onToggleStatus}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onUpdateActivity={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={vi.fn()}
        onDeleteProgress={vi.fn()}
        onDeleteTodo={vi.fn()}
        onOpenTodoSource={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "展开已完成子项" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "已完成" }));
    expect(screen.getByText("Done item")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开已完成子项" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "标记为未完成" }));
    expect(onToggleStatus).toHaveBeenCalledWith(2, "unfinished");
  });

  it("deletes a todo from the context menu", async () => {
    const user = userEvent.setup();
    const onDeleteTodo = vi.fn();

    render(
      <TodoRail
        title="项目待办"
        scopeLabel="Alpha"
        unfinishedTodos={[todoWithoutHistory]}
        finishedTodos={[]}
        activityNameById={new Map([[11, "Kickoff"]])}
        activityOptions={[{ id: 11, title: "Kickoff" }]}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={vi.fn()}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onUpdateActivity={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={vi.fn()}
        onDeleteProgress={vi.fn()}
        onDeleteTodo={onDeleteTodo}
        onOpenTodoSource={vi.fn()}
      />,
    );

    fireEvent.contextMenu(document.getElementById("todo-4") as HTMLElement, {
      clientX: 140,
      clientY: 72,
    });

    await user.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(onDeleteTodo).toHaveBeenCalledWith(4);
  });

  it("filters by priority and keeps the selection across tabs", async () => {
    const user = userEvent.setup();

    render(
      <TodoRail
        title="项目待办"
        scopeLabel="Alpha"
        unfinishedTodos={[
          {
            ...todoWithHistory,
            id: 11,
            content: "Critical legal review",
            priority: "urgent_important",
            updatedAt: "2026-04-06T12:00:00.000Z",
          },
          {
            ...todoWithHistory,
            id: 12,
            content: "Prepare board memo",
            priority: "not_urgent_important",
            updatedAt: "2026-04-06T11:00:00.000Z",
          },
          {
            ...todoWithHistory,
            id: 13,
            content: "Capture follow-up notes",
            priority: "not_urgent_important",
            updatedAt: "2026-04-06T09:00:00.000Z",
          },
        ]}
        finishedTodos={[
          {
            ...finishedTodo,
            id: 14,
            content: "Finished critical item",
            priority: "urgent_important",
          },
          {
            ...finishedTodo,
            id: 15,
            content: "Finished low item",
            priority: "not_urgent_not_important",
          },
        ]}
        activityNameById={new Map([[11, "Kickoff"]])}
        activityOptions={[{ id: 11, title: "Kickoff" }]}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={vi.fn()}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onUpdateActivity={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={vi.fn()}
        onDeleteProgress={vi.fn()}
        onDeleteTodo={vi.fn()}
        onOpenTodoSource={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "P3" }));
    expect(screen.getByText("Prepare board memo")).toBeInTheDocument();
    expect(screen.getByText("Capture follow-up notes")).toBeInTheDocument();
    expect(screen.queryByText("Critical legal review")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "P3" }));
    expect(screen.getByText("Critical legal review")).toBeInTheDocument();
    expect(screen.getByText("Prepare board memo")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "已完成" }));
    expect(screen.getByText("Finished critical item")).toBeInTheDocument();
    expect(screen.getByText("Finished low item")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "P1" }));
    expect(screen.getByText("Finished critical item")).toBeInTheDocument();
    expect(screen.queryByText("Finished low item")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "未完成" }));
    expect(screen.getByText("Critical legal review")).toBeInTheDocument();
    expect(screen.queryByText("Prepare board memo")).not.toBeInTheDocument();
  });

  it("updates a completed sub item from its context menu", async () => {
    const user = userEvent.setup();
    const onUpdateProgress = vi.fn();

    render(
      <TodoRail
        title="项目待办"
        scopeLabel="Alpha"
        unfinishedTodos={[todoWithHistory]}
        finishedTodos={[]}
        activityNameById={new Map([[11, "Kickoff"]])}
        activityOptions={[{ id: 11, title: "Kickoff" }]}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={vi.fn()}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onUpdateActivity={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={onUpdateProgress}
        onDeleteProgress={vi.fn()}
        onDeleteTodo={vi.fn()}
        onOpenTodoSource={vi.fn()}
      />,
    );

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

    render(
      <TodoRail
        title="项目待办"
        scopeLabel="Alpha"
        unfinishedTodos={[todoWithHistory]}
        finishedTodos={[]}
        activityNameById={new Map([[11, "Kickoff"]])}
        activityOptions={[{ id: 11, title: "Kickoff" }]}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={vi.fn()}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onUpdateActivity={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={vi.fn()}
        onDeleteProgress={onDeleteProgress}
        onDeleteTodo={vi.fn()}
        onOpenTodoSource={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "展开已完成子项" }));
    fireEvent.contextMenu(screen.getByText("等待财务确认").closest("article") as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "删除子项" }));

    expect(onDeleteProgress).toHaveBeenCalledWith(102);
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
