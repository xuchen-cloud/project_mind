import { fireEvent, render as baseRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import type { TodoRecord } from "../../lib/types";
import { TodoListItem } from "./TodoListItem";

function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

const todo: TodoRecord = {
  id: 7,
  projectId: 9,
  activityId: 11,
  content: "Review the contract draft",
  status: "unfinished",
  priority: "not_urgent_important",
  createdAt: "2026-04-06T08:00:00.000Z",
  updatedAt: "2026-04-06T10:00:00.000Z",
  progresses: [],
};

describe("TodoListItem", () => {
  function renderItem(partialTodo: Partial<TodoRecord> = {}, extraProps: Record<string, unknown> = {}) {
    return render(
      <TodoListItem
        todo={{ ...todo, ...partialTodo }}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onAddProgress={vi.fn()}
        onUpdateProgress={vi.fn()}
        onDeleteProgress={vi.fn()}
        onToggleExpanded={vi.fn()}
        onOpenContextMenu={vi.fn()}
        {...extraProps}
      />,
    );
  }

  it("does not render the old priority dot button", () => {
    renderItem();

    expect(
      screen.queryByRole("button", { name: "修改优先级：P3 · 不紧急但重要" }),
    ).not.toBeInTheDocument();
  });

  it("stores the priority color on the todo card so the left rail can render it", () => {
    renderItem({ priority: "urgent_important" });

    expect(document.getElementById("todo-7")).toHaveStyle({
      "--todo-priority-color": "var(--color-todo-p1)",
    });
  });

  it("scopes the priority accent to the primary todo area", () => {
    renderItem({
      tags: [{ id: 12, label: "法务", colorKey: "red" }],
      progresses: [
        {
          id: 31,
          todoId: todo.id,
          content: "等待财务确认",
          progressDate: "2026-04-05",
          createdAt: "2026-04-05T09:00:00.000Z",
          status: "unfinished",
          completedAt: null,
          orderIndex: 0,
        },
      ],
    });

    const primary = document.querySelector("#todo-7 .todo-card__primary");
    const subtasks = document.querySelector("#todo-7 .todo-card__subtasks");

    expect(primary).toBeInTheDocument();
    expect(subtasks).toBeInTheDocument();
    expect(primary).toHaveTextContent("Review the contract draft");
    expect(primary).toHaveTextContent("法务");
    expect(primary).not.toHaveTextContent("等待财务确认");
    expect(subtasks).toHaveTextContent("等待财务确认");
  });

  it("keeps the main completion button on the headline row", async () => {
    const user = userEvent.setup();
    const onToggleStatus = vi.fn(async () => undefined);

    renderItem({}, { onToggleStatus });
    await user.click(screen.getByRole("button", { name: "标记为已完成" }));

    expect(onToggleStatus).toHaveBeenCalledWith(7, "finished");
  });

  it("opens a context menu on right click", () => {
    const onOpenContextMenu = vi.fn();

    renderItem({}, { onOpenContextMenu });

    fireEvent.contextMenu(document.getElementById("todo-7") as HTMLElement, {
      clientX: 120,
      clientY: 48,
    });

    expect(onOpenContextMenu).toHaveBeenCalledWith(7, 120, 48);
  });

  it("does not render an empty tag editor by default", () => {
    renderItem();

    expect(screen.queryByPlaceholderText("#标签")).not.toBeInTheDocument();
  });

  it("shows tags as read-only in display mode", () => {
    renderItem({
      tags: [{ id: 12, label: "法务", colorKey: "red" }],
    });

    expect(screen.getByText("法务")).toBeInTheDocument();
    expect(screen.queryByLabelText("移除标签 法务")).not.toBeInTheDocument();
  });

  it("shows removable tags while inline content is editing", async () => {
    const user = userEvent.setup();
    renderItem(
      {
        tags: [{ id: 12, label: "法务", colorKey: "red" }],
      },
      { allowInlineEdit: true, onUpdateTags: vi.fn(), availableTags: [] },
    );

    await user.click(screen.getByRole("button", { name: "Review the contract draft" }));
    expect(screen.getByLabelText("移除标签 法务")).toBeInTheDocument();
  });

  it("marks an unfinished sub item as finished", async () => {
    const user = userEvent.setup();
    const onUpdateProgress = vi.fn(async () => undefined);

    renderItem(
      {
        progresses: [
          {
            id: 31,
            todoId: todo.id,
            content: "等待财务确认",
            progressDate: "2026-04-05",
            createdAt: "2026-04-05T09:00:00.000Z",
            status: "unfinished",
            completedAt: null,
            orderIndex: 0,
          },
        ],
      },
      { onUpdateProgress },
    );

    expect(screen.getByText("等待财务确认")).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "标记子项完成" })
        .compareDocumentPosition(screen.getByText("等待财务确认")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "标记子项完成" }));

    expect(onUpdateProgress).toHaveBeenCalledWith(31, {
      content: "等待财务确认",
      progressDate: "2026-04-05",
      status: "finished",
    });
    expect(screen.getByText("等待财务确认").closest(".todo-progress-item")?.className).toContain(
      "todo-progress-item--completing",
    );
  });

  it("allows clicking an unfinished subitem body to edit it", async () => {
    const user = userEvent.setup();

    renderItem(
      {
        progresses: [
          {
            id: 31,
            todoId: todo.id,
            content: "等待财务确认",
            progressDate: "2026-04-05",
            createdAt: "2026-04-05T09:00:00.000Z",
            status: "unfinished",
            completedAt: null,
            orderIndex: 0,
          },
        ],
      },
      { allowInlineProgress: true },
    );

    await user.click(screen.getByRole("button", { name: "等待财务确认" }));

    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("returns a subitem to display mode immediately while its edit save is pending", async () => {
    const user = userEvent.setup();
    let resolveSave: (() => void) | null = null;
    const onUpdateProgress = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    renderItem(
      {
        progresses: [
          {
            id: 31,
            todoId: todo.id,
            content: "等待财务确认",
            progressDate: "2026-04-05",
            createdAt: "2026-04-05T09:00:00.000Z",
            status: "unfinished",
            completedAt: null,
            orderIndex: 0,
          },
        ],
      },
      { allowInlineProgress: true, onUpdateProgress },
    );

    await user.click(screen.getByRole("button", { name: "等待财务确认" }));
    const textbox = screen.getByRole("textbox");
    await user.clear(textbox);
    await user.type(textbox, "等待财务最终盖章");
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "等待财务最终盖章" })).toBeInTheDocument();

    resolveSave?.();
  });

  it("applies a visual transition state while a sub item is completing", () => {
    renderItem(
      {
        progresses: [
          {
            id: 31,
            todoId: todo.id,
            content: "等待财务确认",
            progressDate: "2026-04-05",
            createdAt: "2026-04-05T09:00:00.000Z",
            status: "finished",
            completedAt: "2026-04-05T09:10:00.000Z",
            orderIndex: 0,
          },
        ],
      },
      {
        expanded: true,
        onToggleExpanded: vi.fn(),
      },
    );

    expect(screen.getByText("等待财务确认").closest("article")?.className).toContain(
      "todo-progress-item",
    );
  });

  it("does not render the sub item date text", () => {
    renderItem({
      progresses: [
        {
          id: 31,
          todoId: todo.id,
          content: "等待财务确认",
          progressDate: "2026-04-05",
          createdAt: "2026-04-05T09:00:00.000Z",
          status: "unfinished",
          completedAt: null,
          orderIndex: 0,
        },
      ],
    });

    expect(screen.queryByText("4月5日")).not.toBeInTheDocument();
  });

  it("renders the expand control alongside the add-subitem row", () => {
    renderItem(
      {
        progresses: [
          {
            id: 31,
            todoId: todo.id,
            content: "已完成确认",
            progressDate: "2026-04-05",
            createdAt: "2026-04-05T09:00:00.000Z",
            status: "finished",
            completedAt: "2026-04-05T09:10:00.000Z",
            orderIndex: 0,
          },
        ],
      },
      { allowInlineProgress: true },
    );

    const expandButton = screen.getByRole("button", { name: "展开已完成子项" });
    const subitemRow = expandButton.closest(".todo-card__subitem-row");

    expect(subitemRow).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加子任务" })).toBeInTheDocument();
  });

  it("does not render the expand control when there are no completed subitems", () => {
    renderItem({}, { allowInlineProgress: true });

    expect(screen.queryByRole("button", { name: "展开已完成子项" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加子任务" })).toBeInTheDocument();
  });

  it("hides the completion button while editing todo content", async () => {
    const user = userEvent.setup();

    renderItem({}, { allowInlineEdit: true });

    await user.click(screen.getByRole("button", { name: "Review the contract draft" }));

    expect(screen.getByRole("button", { name: "标记为已完成" }).className).toContain(
      "todo-card__check--hidden",
    );
    expect(document.getElementById("todo-7")?.getAttribute("data-state")).toContain("editing");
  });

  it("hides the expand button while editing a subitem", async () => {
    const user = userEvent.setup();

    renderItem(
      {
        progresses: [
          {
            id: 31,
            todoId: todo.id,
            content: "已完成确认",
            progressDate: "2026-04-05",
            createdAt: "2026-04-05T09:00:00.000Z",
            status: "finished",
            completedAt: "2026-04-05T09:10:00.000Z",
            orderIndex: 0,
          },
        ],
      },
      { allowInlineProgress: true },
    );

    await user.click(screen.getByRole("button", { name: "添加子任务" }));

    expect(screen.getByRole("button", { name: "展开已完成子项" }).className).toContain(
      "todo-card__expand--hidden",
    );
    expect(document.getElementById("todo-7")?.getAttribute("data-state")).toContain(
      "progress-editing",
    );
  });
});
