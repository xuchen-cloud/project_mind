import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SidebarTagItem } from "./SidebarTagItem";

const api = vi.hoisted(() => ({ projectTagUpsert: vi.fn(), projectTagDelete: vi.fn() }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: api }));
beforeEach(() => vi.resetAllMocks());
function setup(projectId: number | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const select = vi.fn();
  render(<QueryClientProvider client={client}><SidebarTagItem tag={{ id: 7, label: "原标签", colorKey: "blue" }}
    projectId={projectId} selected onSelect={select} /></QueryClientProvider>);
  return { select, invalidate };
}
it.each([null, 3])("edits a tag in scope %s and refreshes all consumers", async projectId => {
  const user = userEvent.setup();
  const { invalidate } = setup(projectId);
  fireEvent.contextMenu(screen.getByRole("button", { name: "#原标签" }));
  await user.click(screen.getByRole("menuitem", { name: "编辑标签" }));
  const input = screen.getByRole("textbox", { name: "标签名称" });
  await user.clear(input);
  await user.type(input, "新名称{Enter}");
  await waitFor(() => expect(api.projectTagUpsert).toHaveBeenCalledWith({ projectId, id: 7, label: "新名称", colorKey: "blue" }));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspace-page"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["todos"] });
});
it("deletes the selected tag and clears its filter", async () => {
  const user = userEvent.setup();
  const { select } = setup(null);
  fireEvent.contextMenu(screen.getByRole("button", { name: "#原标签" }));
  await user.click(screen.getByRole("menuitem", { name: "删除标签" }));
  expect(api.projectTagDelete).toHaveBeenCalledWith({ projectId: null, tagId: 7 });
  await waitFor(() => expect(select).toHaveBeenCalledWith(null));
});
it("cancels an edit with Escape without saving", async () => {
  const user = userEvent.setup();
  setup(3);
  fireEvent.contextMenu(screen.getByRole("button", { name: "#原标签" }));
  await user.click(screen.getByRole("menuitem", { name: "编辑标签" }));
  await user.type(screen.getByRole("textbox", { name: "标签名称" }), "改变{Escape}");
  expect(api.projectTagUpsert).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
