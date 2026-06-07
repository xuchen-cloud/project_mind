import { render as baseRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import type { ProjectListItem, TodoPriority, TodoRecord } from "../../lib/types";
import { TodayTodoSection } from "./TodayTodoSection";

// TodayTodoSection now uses useContactMentionOptions(), which needs a QueryClient.
function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

const projects: ProjectListItem[] = [
  {
    id: 1,
    name: "Alpha",
    kind: "normal",
    status: "active",
    rootPath: "/tmp/alpha",
    summary: "",
    isArchived: false,
    createdAt: "",
    updatedAt: "",
    activityCount: 1,
    unorganizedCount: 0,
    openTodoCount: 2,
  },
  {
    id: 2,
    name: "Beta",
    kind: "normal",
    status: "active",
    rootPath: "/tmp/beta",
    summary: "",
    isArchived: false,
    createdAt: "",
    updatedAt: "",
    activityCount: 1,
    unorganizedCount: 0,
    openTodoCount: 1,
  },
];

const todos: TodoRecord[] = [
  {
    id: 11,
    projectId: 2,
    activityId: 21,
    sourceActivityTitle: "Beta Kickoff",
    content: "Beta unfinished",
    status: "unfinished",
    priority: "not_urgent_important",
    createdAt: "2026-04-06T08:00:00.000Z",
    updatedAt: "2026-04-06T09:00:00.000Z",
    progresses: [],
  },
  {
    id: 12,
    projectId: 1,
    activityId: 31,
    sourceActivityTitle: "Alpha Review",
    content: "Alpha unfinished",
    status: "unfinished",
    priority: "urgent_important",
    createdAt: "2026-04-06T08:00:00.000Z",
    updatedAt: "2026-04-06T10:00:00.000Z",
    progresses: [],
  },
  {
    id: 13,
    projectId: 1,
    activityId: null,
    sourceActivityTitle: null,
    content: "Alpha finished",
    status: "finished",
    priority: "not_urgent_not_important",
    createdAt: "2026-04-06T08:00:00.000Z",
    updatedAt: "2026-04-06T07:00:00.000Z",
    progresses: [],
  },
];

const activityOptionsByProject = new Map<number, Array<{ id: number; title: string }>>([
  [
    1,
    [
      { id: 31, title: "Alpha Review" },
      { id: 32, title: "Alpha Retro" },
    ],
  ],
  [2, [{ id: 21, title: "Beta Kickoff" }]],
]);

function renderSection(
  nextTodos: TodoRecord[] = todos,
  {
    onCreateTodo = vi.fn(),
    onOpenProject = vi.fn(),
  }: {
    onCreateTodo?: (payload: {
      projectId: number;
      activityId?: number;
      content: string;
      priority: TodoPriority;
    }) => void;
    onOpenProject?: (projectId: number) => void;
  } = {},
) {
  return render(
    <TodayTodoSection
      projects={projects}
      activityOptionsByProject={activityOptionsByProject}
      todos={nextTodos}
      onOpenProject={onOpenProject}
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
}

describe("TodayTodoSection", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });

  it("groups todos by project using project order", () => {
    renderSection();

    expect(screen.getAllByRole("button", { name: "Alpha" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Beta" })).toHaveLength(1);
    expect(screen.getByText("Alpha unfinished")).toBeInTheDocument();
    expect(screen.getByText("Beta unfinished")).toBeInTheDocument();
  });

  it("switches between unfinished and finished tabs", async () => {
    const user = userEvent.setup();
    renderSection();

    expect(screen.getByText("Alpha unfinished")).toBeInTheDocument();
    expect(screen.queryByText("Alpha finished")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "已完成" }));

    expect(screen.getByText("Alpha finished")).toBeInTheDocument();
    expect(screen.queryByText("Alpha unfinished")).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no projects", () => {
    render(
      <TodayTodoSection
        projects={[]}
        activityOptionsByProject={new Map()}
        todos={[]}
        onOpenProject={vi.fn()}
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

    expect(screen.getByText("还没有可用项目。")).toBeInTheDocument();
  });

  it("creates a project-level todo inside a project block", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn();

    renderSection(todos, { onCreateTodo });

    await user.click(screen.getByRole("button", { name: "Alpha 新建 Todo" }));
    await user.type(screen.getByPlaceholderText("在 Alpha 里新增一条 Todo"), "整理项目时间线");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onCreateTodo).toHaveBeenCalledWith({
      projectId: 1,
      content: "整理项目时间线",
      priority: "not_urgent_important",
    });
  });

  it("restores an unfinished composer draft for the matching project", async () => {
    window.localStorage.setItem(
      "project-mind:today-todo-draft",
      JSON.stringify({
        projectId: 2,
        content: "休眠前的总览 Todo",
        priority: "urgent_important",
      }),
    );

    renderSection(todos);

    expect(screen.getByDisplayValue("休眠前的总览 Todo")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("在 Beta 里新增一条 Todo"),
    ).toBeInTheDocument();
  });

  it("flushes the overview todo draft on window blur", async () => {
    const user = userEvent.setup();

    renderSection(todos);

    await user.click(screen.getByRole("button", { name: "Alpha 新建 Todo" }));
    await user.type(
      screen.getByPlaceholderText("在 Alpha 里新增一条 Todo"),
      "窗口失焦前的总览 Todo",
    );
    window.dispatchEvent(new Event("blur"));

    expect(
      JSON.parse(
        window.localStorage.getItem("project-mind:today-todo-draft") ?? "{}",
      ),
    ).toMatchObject({
      projectId: 1,
      content: "窗口失焦前的总览 Todo",
      priority: "not_urgent_important",
    });
  });

  it("creates todos without showing an activity selector", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn();

    renderSection(todos, { onCreateTodo });

    await user.click(screen.getByRole("button", { name: "Beta 新建 Todo" }));
    expect(
      screen.queryByLabelText("选择 Beta 的归属 Activity"),
    ).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("在 Beta 里新增一条 Todo"), "跟进 Beta 启动会");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onCreateTodo).toHaveBeenCalledWith({
      projectId: 2,
      content: "跟进 Beta 启动会",
      priority: "not_urgent_important",
    });
  });

  it("hides the empty-state block while composing a todo in an empty project group", async () => {
    const user = userEvent.setup();

    renderSection([todos[1] as TodoRecord]);

    expect(screen.getByText("当前没有未完成 Todo。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Beta 新建 Todo" }));

    expect(screen.getByPlaceholderText("在 Beta 里新增一条 Todo")).toBeInTheDocument();
    expect(screen.queryByText("当前没有未完成 Todo。")).not.toBeInTheDocument();
  });

  it("uses a compact triangle button to collapse the composer", async () => {
    const user = userEvent.setup();

    renderSection(todos);

    await user.click(screen.getByRole("button", { name: "Alpha 新建 Todo" }));

    expect(screen.queryByRole("button", { name: "收起" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Alpha 收起新建 Todo" }));

    expect(screen.queryByPlaceholderText("在 Alpha 里新增一条 Todo")).not.toBeInTheDocument();
  });

  it("opens the related project page from the project name", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();

    renderSection(todos, { onOpenProject });

    await user.click(screen.getByRole("button", { name: "Alpha" }));

    expect(onOpenProject).toHaveBeenCalledWith(1);
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
