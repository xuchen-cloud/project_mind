import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TodoRecord } from "../../lib/types";
import { useListPinsStore } from "../../state/list-pins-store";
import { TodoList } from "./TodoList";

const todos: TodoRecord[] = [1, 2, 3].map(id => ({ id, revision: 1, scope: "project", projectId: 7, content: `Todo ${id}`, status: "unfinished", priority: "not_urgent_important", createdAt: "2026-01-01", updatedAt: `2026-01-0${4-id}`, progresses: [] }));
beforeEach(() => { localStorage.clear(); useListPinsStore.setState({ pins: {} }); });

it("pins through the real menu, preserves existing order within partitions and shares pins across views", () => {
  const onUpdatePriority = vi.fn();
  const onUpdateContent = vi.fn();
  const onToggleStatus = vi.fn();
  const onDeleteTodo = vi.fn();
  const props = { workspaceRoot: "/one", todos, expandedTodoIds: new Set<number>(), onToggleExpanded: vi.fn(), emptyText: "empty", onToggleStatus, onUpdatePriority, onUpdateContent, onAddProgress: vi.fn(), onUpdateProgress: vi.fn(), onDeleteProgress: vi.fn(), onDeleteTodo };
  const client = new QueryClient();
  const ui = (root = "/one", items = todos) => <QueryClientProvider client={client}><TodoList {...props} workspaceRoot={root} todos={items} /></QueryClientProvider>;
  const view = render(ui());
  const ids = () => [...document.querySelectorAll("[data-todo-id]")].map(node => node.getAttribute("data-todo-id"));
  fireEvent.contextMenu(document.getElementById("todo-3")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
  expect(ids()).toEqual(["3", "1", "2"]);
  expect(document.getElementById("todo-3")).toContainElement(screen.getByLabelText("已置顶"));
  expect(onUpdatePriority).not.toHaveBeenCalled();
  expect(onUpdateContent).not.toHaveBeenCalled();
  expect(onToggleStatus).not.toHaveBeenCalled();
  view.rerender(ui("/one", [todos[0], todos[2]]));
  expect(ids()).toEqual(["3", "1"]);
  view.rerender(ui("/two"));
  expect(ids()).toEqual(["1", "2", "3"]);
  view.rerender(ui());
  fireEvent.contextMenu(document.getElementById("todo-3")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
  expect(ids()).toEqual(["1", "2", "3"]);
  fireEvent.contextMenu(document.getElementById("todo-3")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  expect(onDeleteTodo).toHaveBeenCalledWith(3);
});
