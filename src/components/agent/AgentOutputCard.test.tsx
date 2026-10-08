import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const todoObject = { ...object, kind: "todo" as const, id: "18" };
const output: AgentRuntimeOutput = { id: "out", runId: "run", ordinal: 0, revision: 1, intent: { intent: "record_create", scope: object.scope, title: "决策草稿", markdown: "候选正文" }, sources: [], sourceChanged: [], state: "staged", mode: "review", object: null, errorCode: null, dismissed: false };
const operation: AgentOperationEntry = { operationId: "op", runId: "run", requestId: "output:out:1", kind: "record.create", object, beforeRevision: null, afterRevision: 1, beforeSnapshotRef: null, afterSnapshotRef: "v1", undoState: "available", undoOperationId: null, createdAt: "now", recovery: { withdrawn: false, withdrawalRevision: null, restoreAvailable: false } };
const patchOutput: AgentRuntimeOutput = { ...output, intent: { intent: "record_patch", patch: { record: object, baseRevision: 1, requestId: "req", operations: [{ op: "append_inline", blockId: "block-id", expectedBlockHash: "hash", text: "补充" }] } } };
const todoOutput: AgentRuntimeOutput = { ...output, intent: { intent: "todo_create", scope: object.scope, dedupeKey: "evidence-check", content: "核对真实资料", priority: "urgent_important", dueDate: "2026-10-12", tagIds: [3], children: [{ content: "核对历史依据", progressDate: "2026-10-08", dueDate: null }] } };
const updatedTodo: AgentRuntimeOutput = { ...output, intent: { intent: "todo_update", target: todoObject, expectedRevision: 4, changes: [{ change: "deadline", dueDate: "2026-10-20" }, { change: "child_delete", childId: 21 }] } };
function props(overrides: Partial<AgentOutputCardProps> = {}): AgentOutputCardProps {
  return { binding, output, operation: null, onCommit: vi.fn(async () => {}), onDismiss: vi.fn(async () => {}), onUndo: vi.fn(async () => {}), onRestore: vi.fn(async () => {}), ...overrides };
}
beforeEach(() => { vi.clearAllMocks(); mocks.statusGet.mockResolvedValue({ binding }); mocks.resolve.mockImplementation(async ({ kind, id }: { kind: string; id: number }) => ({ kind, id, label: kind === "todo" ? "实际待办" : "实际记录", scope: "project", projectId: 1, route: kind === "todo" ? `/projects/1?focus=todo-${id}` : `/projects/1/records/${id}` })); });

it.each([output, patchOutput, todoOutput, updatedTodo])("confirms %j directly in the message once, then shows inline completion without a dialog or preview", async candidate => {
  let settle!: () => void;
  const onCommit = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
  const input = props({ output: candidate, onCommit });
  const view = render(<AgentOutputCard {...input} />);
  expect(screen.getByText("是否确认执行？")).toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "确认执行" });
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(onCommit).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "正在执行…" })).toBeDisabled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.compare).not.toHaveBeenCalled();
  await act(async () => settle());
  const isTodo = candidate.intent.intent.startsWith("todo_");
  view.rerender(<AgentOutputCard {...input} output={{ ...candidate, state: "committed", object: isTodo ? todoObject : object }} />);
  expect(screen.getByText("已完成")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  const link = await screen.findByRole("button", { name: isTodo ? "实际待办" : "实际记录" });
  fireEvent.click(link);
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(isTodo ? "/projects/1?focus=todo-18" : "/projects/1/records/7"));
});

it("waits for durable dismissal and never claims cancellation locally or confirms a dismissed proposal after reopening", async () => {
  let settle!: () => void;
  const onDismiss = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
  const input = props({ onDismiss });
  const view = render(<AgentOutputCard {...input} />);
  const cancel = screen.getByRole("button", { name: "取消" });
  fireEvent.click(cancel); fireEvent.click(cancel);
  expect(onDismiss).toHaveBeenCalledOnce(); expect(input.onCommit).not.toHaveBeenCalled();
  expect(screen.queryByText("已取消，未作更改。")).not.toBeInTheDocument();
  await act(async () => settle());
  const dismissed = { ...output, revision: 2, dismissed: true };
  view.rerender(<AgentOutputCard {...input} output={dismissed} />);
  expect(screen.getByText("已取消，未作更改。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  view.unmount(); render(<AgentOutputCard {...input} output={dismissed} />);
  expect(screen.getByText("已取消，未作更改。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
});

it("keeps a failed cancellation actionable and shows concise failure without claiming a business change", async () => {
  const input = props({ onDismiss: vi.fn(async () => { throw { code: "REVISION_CONFLICT" }; }) });
  render(<AgentOutputCard {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("已变化"));
  expect(screen.queryByText("已取消，未作更改。")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();
  expect(input.onCommit).not.toHaveBeenCalled();
});

it("preserves collaborate and readonly mode boundaries while offering direct terminal retry", async () => {
  const input = props({ output: { ...todoOutput, mode: "collaborate" }, runActive: true });
  const view = render(<AgentOutputCard {...input} />);
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  expect(input.onCommit).not.toHaveBeenCalled();
  view.rerender(<AgentOutputCard {...input} runActive={false} />);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(input.onCommit).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(<AgentOutputCard {...input} output={{ ...todoOutput, mode: "read_only" }} />);
  expect(screen.getByText("当前为只读模式，此提案不会执行。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
});

it("uses real receipt recovery for inline withdrawal and restoration and keeps details secondary", async () => {
  const todoOperation = { ...operation, object: todoObject, kind: "todo.create" };
  const input = props({ output: { ...todoOutput, state: "committed", object: todoObject, mode: "collaborate" }, operation: todoOperation });
  const view = render(<AgentOutputCard {...input} />);
  expect(screen.getByText("已完成")).toBeInTheDocument();
  expect(screen.getByText("查看详情").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "撤回创建" }));
  await waitFor(() => expect(input.onUndo).toHaveBeenCalledOnce());
  view.rerender(<AgentOutputCard {...input} operation={{ ...todoOperation, undoState: "undone", recovery: { withdrawn: true, withdrawalRevision: 2, restoreAvailable: true } }} />);
  expect(screen.getByText("已撤回")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "恢复待办" }));
  await waitFor(() => expect(input.onRestore).toHaveBeenCalledOnce());
  view.rerender(<AgentOutputCard {...input} operation={{ ...todoOperation, undoState: "undone", recovery: { withdrawn: false, withdrawalRevision: 3, restoreAvailable: false } }} />);
  expect(screen.getByText("已恢复")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("discards old native object responses across workspace generations", async () => {
  let old!: (value: unknown) => void;
  mocks.resolve.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
  const input = props({ output: { ...patchOutput, state: "committed", object } });
  const view = render(<AgentOutputCard {...input} />);
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce());
  view.rerender(<AgentOutputCard {...input} binding={{ ...binding, generation: "new" }} output={{ ...output, id: "new" }} />);
  await act(async () => old({ kind: "note", id: 7, label: "旧对象", scope: "project", projectId: 1, route: "/old" }));
  expect(screen.queryByRole("button", { name: "旧对象" })).not.toBeInTheDocument();
  expect(mocks.navigate).not.toHaveBeenCalled();
});
