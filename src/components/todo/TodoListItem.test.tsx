import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { TodoRecord } from "../../lib/types";
import { TodoListItem } from "./TodoListItem";

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
  it("updates priority from the dropdown and opens the source activity", async () => {
    const user = userEvent.setup();
    const onUpdatePriority = vi.fn(async () => undefined);
    const onOpenTodoSource = vi.fn();

    render(
      <TodoListItem
        todo={todo}
        activityNameById={new Map([[11, "预算讨论"]])}
        onToggleStatus={vi.fn()}
        onUpdatePriority={onUpdatePriority}
        onUpdateContent={vi.fn()}
        onAddProgress={vi.fn()}
        onOpenTodoSource={onOpenTodoSource}
        onToggleExpanded={vi.fn()}
        onOpenContextMenu={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "修改优先级：P3 · 不紧急但重要" }));
    await user.click(screen.getByRole("menuitemradio", { name: "P1 紧急且重要" }));

    expect(onUpdatePriority).toHaveBeenCalledWith(7, "urgent_important");

    await user.click(screen.getByRole("button", { name: "预算讨论" }));
    expect(onOpenTodoSource).toHaveBeenCalledWith(todo);
  });

  it("opens a context menu on right click", () => {
    const onOpenContextMenu = vi.fn();

    render(
      <TodoListItem
        todo={todo}
        activityNameById={new Map([[11, "预算讨论"]])}
        onToggleStatus={vi.fn()}
        onUpdatePriority={vi.fn()}
        onUpdateContent={vi.fn()}
        onAddProgress={vi.fn()}
        onOpenTodoSource={vi.fn()}
        onToggleExpanded={vi.fn()}
        onOpenContextMenu={onOpenContextMenu}
      />,
    );

    fireEvent.contextMenu(document.getElementById("todo-7") as HTMLElement, {
      clientX: 120,
      clientY: 48,
    });

    expect(onOpenContextMenu).toHaveBeenCalledWith(7, 120, 48);
  });
});
