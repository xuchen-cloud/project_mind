import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentPublishedSource } from "./AgentPublishedSource";

const mocks = vi.hoisted(() => ({ overviewGet: vi.fn() }));
vi.mock("../../services/agentApi", () => ({ agentApi: mocks }));
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: ({ source }: { source: { title: string } }) =>
  <div data-testid="original-source">{source.title}</div> }));

const binding = { workspaceId: "w1", generation: "g1" };
const source = { projectId: 7, revision: 4, itemId: "parent-1", digest: "sha256:parent" };
const item = { id: source.itemId, text: "前半段", sourceRefs: [{ object: { workspaceId: "w1", scope: { kind: "project", projectId: 7 },
  kind: "record", id: "record-1" }, revision: "sha256:raw", locator: { kind: "text" }, title: "原始记录" }] };
function page(cursor: string | null) {
  return { revision: source.revision, items: [{ item: { ...item, text: cursor ? "后半段" : "前半段" },
    textOffset: cursor ? 3 : 0, complete: !!cursor }], nextCursor: cursor ? null : "next" };
}
function renderSource(selected = source, selectedBinding = binding) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><AgentPublishedSource binding={selectedBinding} source={selected} /></QueryClientProvider>);
  return { client, view };
}
beforeEach(() => { vi.clearAllMocks(); });

it("reads the fixed published version only after expansion and pages its original evidence", async () => {
  mocks.overviewGet.mockImplementation(async (_binding: unknown, input: { cursor: string | null }) => page(input.cursor));
  renderSource();
  expect(mocks.overviewGet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "项目概览依据 · 版本 4" }));
  expect(await screen.findByText("前半段")).toBeVisible();
  expect(screen.getByTestId("original-source")).toHaveTextContent("原始记录");
  expect(mocks.overviewGet).toHaveBeenCalledWith(binding, { scope: { kind: "project", projectId: 7 },
    version: 4, sections: [], itemIds: ["parent-1"], cursor: null, budgetChars: 2000 });
  fireEvent.click(screen.getByRole("button", { name: "继续读取项目概览依据" }));
  expect(await screen.findByText("后半段")).toBeVisible();
  expect(mocks.overviewGet).toHaveBeenLastCalledWith(binding, expect.objectContaining({ version: 4, cursor: "next", itemIds: ["parent-1"] }));
  expect(screen.getAllByTestId("original-source")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "项目概览依据 · 版本 4" }));
  mocks.overviewGet.mockResolvedValue({ revision: 4, items: [], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "项目概览依据 · 版本 4" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已不可用");
  expect(screen.queryByTestId("original-source")).not.toBeInTheDocument();
});

it("states when a parent item is no longer readable without displaying invented evidence", async () => {
  mocks.overviewGet.mockResolvedValue({ revision: 4, items: [], nextCursor: null });
  const { view } = renderSource();
  fireEvent.click(screen.getByRole("button", { name: /项目概览依据/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已不可用");
  expect(screen.queryByTestId("original-source")).not.toBeInTheDocument();
  view.unmount();
  mocks.overviewGet.mockRejectedValue({ code: "PERMISSION_DENIED", message: "无权读取" });
  renderSource();
  fireEvent.click(screen.getByRole("button", { name: /项目概览依据/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已不可用");
  expect(screen.queryByText("前半段")).not.toBeInTheDocument();
});

it("isolates delayed parent responses when binding and project change", async () => {
  let finish!: (value: ReturnType<typeof page>) => void;
  mocks.overviewGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ revision: 5, items: [{ item: { ...item, id: "parent-2", text: "新项目正文", sourceRefs: [] },
      textOffset: 0, complete: true }], nextCursor: null });
  const { client, view } = renderSource();
  fireEvent.click(screen.getByRole("button", { name: /项目概览依据/ }));
  await waitFor(() => expect(mocks.overviewGet).toHaveBeenCalledTimes(1));
  const next = { projectId: 9, revision: 5, itemId: "parent-2", digest: "sha256:new" };
  const nextBinding = { ...binding, generation: "g2" };
  view.rerender(<QueryClientProvider client={client}><AgentPublishedSource binding={nextBinding} source={next} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "项目概览依据 · 版本 5" }));
  expect(await screen.findByText("新项目正文")).toBeVisible();
  await act(async () => { finish(page(null)); });
  expect(screen.queryByText("前半段")).not.toBeInTheDocument();
  expect(mocks.overviewGet).toHaveBeenLastCalledWith(nextBinding, expect.objectContaining({
    scope: { kind: "project", projectId: 9 }, version: 5, itemIds: ["parent-2"] }));
});
