import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentOperationEntry, AgentRuntimeOutput } from "../../lib/agent-types";
import { AgentOutputCard, type AgentOutputCardProps } from "./AgentOutputCard";
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), statusGet: vi.fn(), resolve: vi.fn(), compare: vi.fn(), preview: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../services/agentApi", async importOriginal => ({ ...await importOriginal<typeof import("../../services/agentApi")>(), agentApi: { statusGet: mocks.statusGet, outputPreview: mocks.preview } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { internalReferenceResolve: mocks.resolve } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { versionsCompare: mocks.compare } }));
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: () => <div>原始来源</div> }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project", projectId: 1 } as const, kind: "record" as const, id: "7" };
const output: AgentRuntimeOutput = { id: "out", runId: "run", ordinal: 0, revision: 1, intent: { intent: "record_create", scope: object.scope, title: "决策草稿", markdown: "候选正文" }, sources: [], sourceChanged: [], state: "staged", mode: "review", object: null, errorCode: null };
const operation: AgentOperationEntry = { operationId: "op", runId: "run", requestId: "output:out:1", kind: "record.create", object, beforeRevision: null, afterRevision: 1, beforeSnapshotRef: null, afterSnapshotRef: "v1", undoState: "available", undoOperationId: null, createdAt: "now", recovery: { withdrawn: false, withdrawalRevision: null, restoreAvailable: false } };
const patchOutput: AgentRuntimeOutput = { ...output, intent: { intent: "record_patch", patch: { record: object, baseRevision: 1, requestId: "req", operations: [{ op: "append_inline", blockId: "b", expectedBlockHash: "h", text: "补充" }] } } };
const actualPreview = { outputId: output.id, revision: 1, baseRevision: 1, difference: { added: ["a"], modified: ["b", "c"], deleted: ["d"], moved: ["e"] } };
function props(overrides: Partial<AgentOutputCardProps> = {}): AgentOutputCardProps {
  return { binding, output, operation: null, onCommit: vi.fn(async () => {}), onUndo: vi.fn(async () => {}), onRestore: vi.fn(async () => {}), ...overrides };
}
beforeEach(() => { vi.clearAllMocks(); mocks.statusGet.mockResolvedValue({ binding }); mocks.resolve.mockResolvedValue({ kind: "note", id: 7, label: "原记录标题", scope: "project", projectId: 1, route: "/projects/1/records/7" }); });

it("uses the frozen review mode, confirms explicitly and prevents repeated submission", async () => {
  let settle!: () => void;
  const onCommit = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
  const input = props({ onCommit });
  const view = render(<AgentOutputCard {...input} />);
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "确认保存成果" })).toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "保存成果" });
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(onCommit).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "正在处理…" })).toBeDisabled();
  await act(async () => settle());
  view.rerender(<AgentOutputCard {...input} output={{ ...output, state: "committing" }} />);
  expect(screen.getByText("正在保存")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认保存" })).not.toBeInTheDocument();
  view.rerender(<AgentOutputCard {...input} output={{ ...output, state: "committed", mode: "collaborate", object }} />);
  expect(screen.getByText("已保存")).toBeInTheDocument();
  expect(screen.getByText(/本次运行已自动保存此成果/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重试保存" })).not.toBeInTheDocument();
});

it("offers retry only for failed writable output and keeps review confirmation", async () => {
  const input = props({ output: { ...output, state: "failed", errorCode: "SOURCE_CHANGED" } });
  const view = render(<AgentOutputCard {...input} />);
  expect(screen.getByRole("alert")).toHaveTextContent("资料已变化");
  fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
  expect(input.onCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存成果" }));
  await waitFor(() => expect(input.onCommit).toHaveBeenCalledOnce());
  view.rerender(<AgentOutputCard {...input} output={{ ...input.output, mode: "read_only" }} />);
  expect(screen.queryByRole("button", { name: "重试保存" })).not.toBeInTheDocument();
});

it("lets a terminal collaborate run retry its uncommitted candidate without polling or automatic UI save", async () => {
  const input = props({ output: { ...output, mode: "collaborate" }, runActive: true });
  const view = render(<AgentOutputCard {...input} />);
  expect(screen.getByText("等待助手保存，可刷新查看结果。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重试保存" })).not.toBeInTheDocument();
  view.rerender(<AgentOutputCard {...input} runActive={false} />);
  expect(screen.getByText("运行已结束，此候选尚未保存，可手动重试。")).toBeInTheDocument();
  expect(input.onCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
  await waitFor(() => expect(input.onCommit).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("uses actual receipt recovery state for withdrawal and restoration", async () => {
  const input = props({ output: { ...output, state: "committed", object }, operation });
  const view = render(<AgentOutputCard {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "撤回创建" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(input.onUndo).toHaveBeenCalledOnce());
  view.rerender(<AgentOutputCard {...input} operation={{ ...operation, undoState: "undone", recovery: { withdrawn: true, withdrawalRevision: 2, restoreAvailable: true } }} />);
  expect(screen.queryByRole("button", { name: "打开记录" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "恢复记录" }));
  await waitFor(() => expect(input.onRestore).toHaveBeenCalledOnce());
});

it("opens the actual existing Record, loads committed diff only on request, and explains undo conflicts", async () => {
  const patch: AgentRuntimeOutput = { ...output, object, state: "committed", intent: { intent: "record_patch", patch: { record: object, baseRevision: 1, requestId: "req", operations: [{ op: "append_inline", blockId: "b", expectedBlockHash: "h", text: "补充" }] } } };
  const input = props({ output: patch, operation: { ...operation, kind: "record.patch", beforeRevision: 1, afterRevision: 2, beforeSnapshotRef: "v1", afterSnapshotRef: "v2", recovery: null }, onUndo: vi.fn(async () => { throw { code: "UNDO_CONFLICT" }; }) });
  mocks.compare.mockResolvedValue({ added: [], deleted: [], modified: ["b"], moved: [] });
  render(<AgentOutputCard {...input} />);
  await waitFor(() => expect(screen.getByText("原记录标题")).toBeInTheDocument());
  expect(mocks.compare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开记录" }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/projects/1/records/7"));
  fireEvent.click(screen.getByRole("button", { name: "查看实际版本差异" }));
  await waitFor(() => expect(screen.getByText(/实际版本差异：新增 0 块/)).toBeInTheDocument());
  expect(mocks.compare).toHaveBeenCalledWith(binding, { scope: object.scope, recordId: 7 }, "v1", "v2");
  fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("后续内容已保留"));
});

it("ignores old metadata responses when the workspace binding changes", async () => {
  let resolveOld!: (value: unknown) => void;
  mocks.resolve.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const input = props({ output: { ...output, object, state: "committed", intent: { intent: "record_patch", patch: { record: object, baseRevision: 1, requestId: "r", operations: [] } } } });
  const view = render(<AgentOutputCard {...input} />);
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce());
  view.rerender(<AgentOutputCard {...input} binding={{ ...binding, generation: "new" }} output={{ ...output, id: "new" }} />);
  await act(async () => resolveOld({ label: "旧工作区标题", scope: "project", projectId: 1, route: "/old" }));
  expect(screen.queryByText("旧工作区标题")).not.toBeInTheDocument();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("computes the actual patch difference only when confirming and blocks save until it settles", async () => {
  let settle!: (value: typeof actualPreview) => void;
  mocks.preview.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  const input = props({ output: patchOutput });
  render(<AgentOutputCard {...input} />);
  expect(mocks.preview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  const dialog = screen.getByRole("dialog", { name: "确认保存成果" });
  expect(within(dialog).getByRole("button", { name: "保存成果" })).toBeDisabled();
  expect(within(dialog).getByRole("status")).toHaveTextContent("计算真实差异");
  expect(mocks.preview).toHaveBeenCalledWith(binding, { outputId: "out", expectedRevision: 1 });
  expect(mocks.compare).not.toHaveBeenCalled();
  await act(async () => settle(actualPreview));
  expect(within(dialog).getByText("真实差异 · 基于修订 1：新增 1 块，修改 2 块，删除 1 块，移动 1 块。")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "保存成果" })).toBeEnabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存成果" }));
  await waitFor(() => expect(input.onCommit).toHaveBeenCalledOnce());
});

it.each([
  [{ code: "REVISION_CONFLICT" }, "记录基线或候选已变化"],
  [{ code: "IO_FAILED" }, "真实差异加载失败"],
])("blocks patch save when actual preview fails: %j", async (failure, explanation) => {
  mocks.preview.mockRejectedValueOnce(failure);
  const input = props({ output: patchOutput });
  render(<AgentOutputCard {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  const dialog = screen.getByRole("dialog", { name: "确认保存成果" });
  await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(explanation));
  const save = within(dialog).getByRole("button", { name: "保存成果" });
  expect(save).toBeDisabled(); fireEvent.click(save);
  expect(input.onCommit).not.toHaveBeenCalled();
});

it("discards an old workspace patch preview and keeps the new confirmation blocked until its own response", async () => {
  let settleOld!: (value: typeof actualPreview) => void;
  let settleNew!: (value: typeof actualPreview) => void;
  mocks.preview.mockImplementationOnce(() => new Promise(resolve => { settleOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { settleNew = resolve; }));
  const input = props({ output: patchOutput });
  const view = render(<AgentOutputCard {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  view.rerender(<AgentOutputCard {...input} binding={{ ...binding, generation: "new" }} />);
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  const dialog = screen.getByRole("dialog", { name: "确认保存成果" });
  await act(async () => settleOld(actualPreview));
  expect(within(dialog).queryByText(/真实差异 · 基于修订/)).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "保存成果" })).toBeDisabled();
  await act(async () => settleNew(actualPreview));
  expect(within(dialog).getByRole("button", { name: "保存成果" })).toBeEnabled();
  expect(mocks.preview).toHaveBeenLastCalledWith({ ...binding, generation: "new" }, { outputId: "out", expectedRevision: 1 });
});
