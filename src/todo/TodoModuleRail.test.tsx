import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUiStoreState, useUiStore } from "../state/ui-store";
import { TodoModuleRail } from "./TodoModuleRail";

const change = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./use-todo-module", () => ({
  useTodoModule: () => ({
    view: {
      kind: "current-project",
      projectId: 7,
      projects: [],
      unfinishedTodos: [],
      finishedTodos: [],
    },
    change,
    refresh: vi.fn(),
    refreshing: false,
    ready: true,
    error: null,
  }),
}));

vi.mock("../hooks/useContactMentionOptions", () => ({
  useContactMentionOptions: () => ({}),
}));

describe("TodoModuleRail", () => {
  beforeEach(() => {
    change.mockClear();
    useUiStore.setState(createUiStoreState());
    installMemoryLocalStorage();
  });

  it("fixes Current Project creation ownership without rendering a selector", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TodoModuleRail scope={{ kind: "current-project", projectId: 7 }} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    expect(screen.queryByRole("combobox", { name: "Todo 归属" })).not.toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText("写下一条需要推进的 Todo，可用 #标签"),
      "推进当前项目",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(change).toHaveBeenCalledWith({
      type: "create",
      ownership: { scope: "project", projectId: 7 },
      content: "推进当前项目",
      priority: "not_urgent_important",
      dueDate: undefined,
    });
  });
});

function installMemoryLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}
