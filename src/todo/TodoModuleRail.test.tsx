import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUiStoreState, useUiStore } from "../state/ui-store";
import { useFeedbackStore } from "../state/feedback-store";
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
    change.mockResolvedValue(undefined);
    useUiStore.setState(createUiStoreState());
    useFeedbackStore.setState({ toasts: [] });
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
      screen.getByPlaceholderText("写下要做的事"),
      "推进当前项目",
    );
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(change).toHaveBeenCalledWith({
      type: "create",
      ownership: { scope: "project", projectId: 7 },
      content: "推进当前项目",
      priority: "not_urgent_important",
      dueDate: undefined,
    });
  });

  it("reports a rejected create operation with exactly one visible error notification", async () => {
    const user = userEvent.setup();
    change.mockRejectedValueOnce(new Error("创建失败"));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TodoModuleRail scope={{ kind: "current-project", projectId: 7 }} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "新增代办" }));
    await user.type(
      screen.getByPlaceholderText("写下要做的事"),
      "保留失败草稿",
    );
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(useFeedbackStore.getState().toasts).toEqual([
      expect.objectContaining({
        tone: "error",
        title: "Todo 处理失败",
        detail:
          "Todo 创建结果无法确认，草稿已保留：Error: 创建失败；Todo 列表已刷新，请核对。",
      }),
    ]);
    expect(screen.getByPlaceholderText("写下要做的事")).toHaveValue(
      "保留失败草稿",
    );
    expect(screen.getByRole("button", { name: "请先核对" })).toBeDisabled();
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
