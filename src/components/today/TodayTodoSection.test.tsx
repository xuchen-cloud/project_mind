import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProjectListItem, TodoRecord } from "../../lib/types";
import { TodayTodoSection } from "./TodayTodoSection";

const projects: ProjectListItem[] = [
  {
    id: 1,
    name: "Alpha",
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

function renderSection(nextTodos: TodoRecord[] = todos, onCreateTodo = vi.fn()) {
  render(
    <TodayTodoSection
      projects={projects}
      activityOptionsByProject={activityOptionsByProject}
      todos={nextTodos}
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
  it("groups todos by project using project order", () => {
    renderSection();

    const headings = screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
    expect(headings).toEqual(["Alpha", "Beta"]);
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

  it("shows an empty state when there are no matching todos", () => {
    renderSection([]);

    expect(screen.getByText("当前没有需要展示的 Todo")).toBeInTheDocument();
  });

  it("creates a project-level todo after choosing a project", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn();

    renderSection(todos, onCreateTodo);

    await user.type(screen.getByPlaceholderText("例如：整理本周访谈结论"), "整理项目时间线");
    await user.selectOptions(screen.getByLabelText("选择归属项目"), "1");
    await user.click(screen.getByRole("button", { name: "新增 Todo" }));

    expect(onCreateTodo).toHaveBeenCalledWith({
      projectId: 1,
      content: "整理项目时间线",
      priority: "not_urgent_important",
    });
  });

  it("includes the selected activity when creating a todo", async () => {
    const user = userEvent.setup();
    const onCreateTodo = vi.fn();

    renderSection(todos, onCreateTodo);

    await user.type(screen.getByPlaceholderText("例如：整理本周访谈结论"), "跟进 Beta 启动会");
    await user.selectOptions(screen.getByLabelText("选择归属项目"), "2");
    await user.selectOptions(screen.getByLabelText("选择归属 Activity"), "21");
    await user.click(screen.getByRole("button", { name: "新增 Todo" }));

    expect(onCreateTodo).toHaveBeenCalledWith({
      projectId: 2,
      activityId: 21,
      content: "跟进 Beta 启动会",
      priority: "not_urgent_important",
    });
  });
});
