import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "../../lib/queryKeys";
import type { TodoRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { TodoModuleRail } from "../../todo/TodoModuleRail";

const initial: TodoRecord = {
  id: 1, revision: 1, scope: "workspace", projectId: null,
  content: "原正文", dueDate: null, status: "unfinished",
  priority: "not_urgent_important", tags: [], progresses: [],
  createdAt: "2026-11-11", updatedAt: "2026-11-11",
};
const tag = { id: 9, label: "work", colorKey: "blue", usageCount: 0, createdAt: "2026-11-11", updatedAt: "2026-11-11" };

beforeEach(() => {
  useUiStore.setState(createUiStoreState());
  useFeedbackStore.setState({ toasts: [] });
  vi.spyOn(projectMindApi, "projectsList").mockResolvedValue([]);
  vi.spyOn(projectMindApi, "workspacePageGet").mockResolvedValue({ quickNote: null, records: [], unfinishedTodos: [initial], finishedTodos: [] });
  vi.spyOn(projectMindApi, "projectTagSettingsGet").mockResolvedValue({ tags: [tag] });
  vi.spyOn(recordDocumentApi, "bindingGet").mockResolvedValue({ workspaceId: "workspace-a", generation: "open-a" });
});
afterEach(() => { vi.restoreAllMocks(); });

function mountRail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace-a" }, recentWorkspaces: [] });
  const view = render(<QueryClientProvider client={client}><TodoModuleRail scope={{ kind: "workspace" }} workspaceRoot="/workspace-a" /></QueryClientProvider>);
  return { client, ...view };
}

describe("Todo inline editors through TodoModuleRail", () => {
  it("shows canonical hashtag content, sequential saves and remote cache updates", async () => {
    const user = userEvent.setup();
    let confirm!: () => void;
    const saved = { ...initial, content: "新正文", revision: 2, tags: [tag] };
    const update = vi.spyOn(projectMindApi, "todoUpdateContent")
      .mockImplementationOnce(() => new Promise((resolve) => { confirm = () => resolve(saved); }))
      .mockResolvedValueOnce({ ...saved, content: "第二次正文", revision: 3 });
    const { client } = mountRail();
    await user.click(await screen.findByRole("button", { name: "原正文" }));
    const textbox = screen.getByRole("textbox", { name: "" });
    textbox.textContent = "新正文 #work";
    fireEvent.input(textbox);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toMatchObject({ content: "新正文", tagIds: [9], expectedRevision: 1 });
    const displayed: (string | null)[] = [];
    const observer = new MutationObserver(() => {
      displayed.push(document.querySelector(".todo-inline-content")?.getAttribute("aria-label") ?? null);
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    await act(async () => { confirm(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "新正文" })).toBeInTheDocument());
    observer.disconnect();
    expect(displayed).not.toContain("原正文");
    expect(client.getQueryData<TodoRecord[]>(queryKeys.todoCollections.workspaceRail)?.[0].tags).toEqual([tag]);
    expect(screen.getAllByText("work").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "新正文" }));
    const secondTextbox = screen.getByRole("textbox", { name: "" });
    secondTextbox.textContent = "第二次正文";
    fireEvent.input(secondTextbox);
    displayed.length = 0;
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "第二次正文" })).toBeInTheDocument());
    observer.disconnect();
    expect(displayed).not.toContain("新正文");
    expect(update.mock.calls[1][0]).toMatchObject({ content: "第二次正文", expectedRevision: 2 });
    await act(async () => { client.setQueryData(queryKeys.todoCollections.workspaceRail, [{ ...saved, revision: 4, content: "远端更新" }]); });
    expect(await screen.findByRole("button", { name: "远端更新" })).toBeInTheDocument();
  });

  it.each(["success", "failure"])("keeps the new Workspace view when an old save returns %s", async (outcome) => {
    const user = userEvent.setup();
    let resolve!: (todo: TodoRecord) => void;
    let reject!: (error: Error) => void;
    const update = vi.spyOn(projectMindApi, "todoUpdateContent")
      .mockImplementationOnce(() => new Promise((resolveSave, rejectSave) => { resolve = resolveSave; reject = rejectSave; }));
    const { client, unmount } = mountRail();
    await user.click(await screen.findByRole("button", { name: "原正文" }));
    const textbox = screen.getByRole("textbox", { name: "" });
    textbox.textContent = "旧工作区草稿 @20270315";
    fireEvent.input(textbox);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    // App keys the Todo sidebar by Workspace root. Keep its shared QueryClient
    // while removing the previous open's queries, as the Workspace switch does.
    unmount();
    client.clear();
    client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace-b" }, recentWorkspaces: [] });
    const other = { ...initial, content: "B 的独立正文" };
    vi.mocked(projectMindApi.workspacePageGet).mockResolvedValue({ quickNote: null, records: [], unfinishedTodos: [other], finishedTodos: [] });
    vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ workspaceId: "workspace-b", generation: "open-b" });
    render(<QueryClientProvider client={client}><TodoModuleRail scope={{ kind: "workspace" }} workspaceRoot="/workspace-b" /></QueryClientProvider>);
    await screen.findByRole("button", { name: "B 的独立正文" });
    await act(async () => {
      if (outcome === "success") resolve({ ...initial, revision: 2, content: "旧工作区草稿", dueDate: "2027-03-15" });
      else reject(new Error("A 保存失败"));
    });
    await waitFor(() => expect(client.getQueryData<TodoRecord[]>(queryKeys.todoCollections.workspaceRail)).toEqual([other]));
    expect(screen.getByRole("button", { name: "B 的独立正文" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("截止日期 2027-03-15")).not.toBeInTheDocument();
    expect(useFeedbackStore.getState().toasts).toHaveLength(0);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("磁盘写入失败"), JSON.stringify({ code: "REVISION_CONFLICT", message: "head changed" })])("retains the subtask and date on rejected I/O or revision, reports once and retries", async (error) => {
    const user = userEvent.setup();
    let reject!: (error: unknown) => void;
    const add = vi.spyOn(projectMindApi, "todoAddProgress")
      .mockImplementationOnce(() => new Promise((_resolve, rejectSave) => { reject = rejectSave; }))
      .mockResolvedValueOnce({ id: 21, todoId: 1, todoRevision: 2, content: "提交完整方案", progressDate: "2026-11-11", dueDate: "2027-03-15", status: "unfinished", completedAt: null, orderIndex: 0, createdAt: "2026-11-11" });
    mountRail();
    await screen.findByRole("button", { name: "原正文" });
    await user.click(screen.getByRole("button", { name: "添加子任务" }));
    await user.type(screen.getByRole("textbox"), "@20270315 提交完整方案");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    await act(async () => { reject(error); });
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("@20270315 提交完整方案"));
    expect(useFeedbackStore.getState().toasts).toHaveLength(1);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add.mock.calls[1][0]).toEqual(add.mock.calls[0][0]);
    expect(await screen.findByText("提交完整方案")).toBeInTheDocument();
  });
});
