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

function renderSection(nextTodos: TodoRecord[] = todos) {
  render(
    <TodayTodoSection
      projects={projects}
      todos={nextTodos}
      onToggleStatus={vi.fn()}
      onUpdatePriority={vi.fn()}
      onUpdateContent={vi.fn()}
      onAddProgress={vi.fn()}
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
});
