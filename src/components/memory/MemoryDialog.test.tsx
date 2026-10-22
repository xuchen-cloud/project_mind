import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFact, MemoryList } from "../../services/memoryApi";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), bindingGet: vi.fn(), command: vi.fn() }));
vi.mock("../../services/memoryApi", async importOriginal => ({ ...await importOriginal<typeof import("../../services/memoryApi")>(), memoryApi: { execute: mocks.execute } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: mocks.bindingGet } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { command: mocks.command } }));
const binding = { workspaceId: "w1", generation: "g1" };
import { MemoryDialog } from "./MemoryDialog";
const workspace = { kind: "workspace" } as const;
function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return { id: "f1", scope: workspace, category: "preference", content: "使用中文", condition: "讨论产品时", core: false, state: "active", confirmation: "confirmed", revision: 3, validFrom: null, validTo: null, supersededBy: null, sources: [], locked: false, autoOrganizedAt: null, rollbackId: null, ...overrides };
}
function list(facts = [fact()]): MemoryList { return { facts, proposals: [], settings: { requireApproval: false } }; }
function open(scope: typeof workspace | { kind: "project"; projectId: number } = workspace) { return render(<MemoryDialog scope={scope} workspaceRoot="/workspace" onClose={() => {}} />, { wrapper: MemoryRouter }); }
beforeEach(() => { mocks.command.mockReset().mockImplementation((command: string) => Promise.resolve(command === "memory_schedule_get" ? {enabled:false,intervalHours:24,localTime:"03:00",timezone:"UTC",revision:0,status:null} : {path:"/workspace/SKILL.md",content:"shared behavior",revision:"r1"})); mocks.bindingGet.mockReset().mockResolvedValue(binding); mocks.execute.mockReset().mockResolvedValue(list()); });
describe("MemoryDialog", () => {
  it("loads the shared behavior editor only when opened, with the captured binding", async () => {
    open();
    await screen.findByText("使用中文");
    expect(mocks.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "记忆与整理行为" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "行为文件" })).toHaveValue("shared behavior"));
    expect(mocks.command).toHaveBeenCalledWith("memory_behavior_get", { binding });
    expect(mocks.bindingGet).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "行为文件" }), {target:{value:"draft"}});
    fireEvent.click(screen.getByRole("button", { name: "记忆与整理行为" }));
    fireEvent.click(screen.getByRole("button", { name: "记忆与整理行为" }));
    expect(screen.getByRole("textbox", { name: "行为文件" })).toHaveValue("draft");
    expect(mocks.command).toHaveBeenCalledTimes(2);
  });

  it("loads inactive facts and keeps disabled facts discoverable and re-enableable", async () => {
    mocks.execute.mockResolvedValue(list([fact({ state: "disabled" })]));
    open();
    await screen.findByRole("tab", { name: "已停用与历史" });
    expect(mocks.execute).toHaveBeenCalledWith(binding, workspace, { operation: "list", scope: workspace, includeInactive: true });
    fireEvent.click(screen.getByRole("tab", { name: "已停用与历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "启用" }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledWith(binding, workspace, expect.objectContaining({ operation: "apply", changes: [{ action: "enable", scope: workspace, id: "f1", expectedRevision: 3 }] })));
  });
  it("edits content, explicitly clears condition, and changes core using CAS", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "内容" }), { target: { value: "简明中文" } });
    fireEvent.change(screen.getByRole("textbox", { name: "适用条件" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "核心记忆" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledWith(binding, workspace, expect.objectContaining({ operation: "apply", changes: [{ action: "patch", scope: workspace, id: "f1", expectedRevision: 3, content: "简明中文", condition: null, core: true }] })));
  });
  it("shows evidence without guessing its current availability", async () => {
    mocks.execute.mockResolvedValue(list([fact({ sources: [{ kind: "message", id: "m1", scope: workspace, label: "原始对话", excerpt: "请使用中文" }] })]));
    open();
    fireEvent.click(await screen.findByText("来源（1）"));
    expect(screen.getByText("请使用中文")).toBeInTheDocument();
    expect(screen.getByText("当前可用性尚未核验")).toBeInTheDocument();
  });
  it("defaults approval off and saves the opt-in", async () => {
    open();
    const toggle = await screen.findByRole("checkbox", { name: "自动整理需我批准" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledWith(binding, workspace, { operation: "settings", requireApproval: true }));
  });
  it("offers approval and rejection only for scoped proposals", async () => {
    mocks.execute.mockResolvedValue({ ...list(), proposals: [{ id: "p1", createdAt: new Date().toISOString(), changes: [{ action: "patch", scope: workspace, id: "f1", expectedRevision: 3, content: "新结论" }] }, { id: "p2", createdAt: new Date().toISOString(), changes: [{ action: "add", scope: { kind: "project", projectId: 8 }, category: "decision", content: "其他项目" }] }] });
    open();
    fireEvent.click(await screen.findByRole("tab", { name: "待批准" }));
    expect(await screen.findByText("修改：新结论")).toBeInTheDocument();
    expect(screen.queryByText("其他项目")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledWith(binding, workspace, expect.objectContaining({ operation: "approve", proposalId: "p1" })));
  });
  it("rolls back recent organization by atomic rollback id", async () => {
    mocks.execute.mockResolvedValue(list([fact({ autoOrganizedAt: new Date().toISOString(), rollbackId: "r1" })]));
    open();
    fireEvent.click(await screen.findByRole("tab", { name: "最近 24 小时整理" }));
    fireEvent.click(await screen.findByRole("button", { name: "撤销本次整理" }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledWith(binding, workspace, expect.objectContaining({ operation: "rollback", rollbackId: "r1" })));
  });
  it("ignores a previous scope's late response", async () => {
    let resolve!: (result: MemoryList) => void;
    mocks.execute.mockImplementationOnce(() => new Promise<MemoryList>(r => { resolve = r; })).mockResolvedValue(list([fact({ scope: { kind: "project", projectId: 2 }, category: "decision", content: "项目决定" })]));
    const view = open();
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    view.rerender(<MemoryDialog scope={{ kind: "project", projectId: 2 }} workspaceRoot="/workspace" onClose={() => {}} />);
    await screen.findByText("项目决定");
    await act(async () => resolve(list()));
    expect(screen.queryByText("使用中文")).not.toBeInTheDocument();
    expect(screen.getByText("项目决定")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "偏好" })).not.toBeInTheDocument();
  });
  it("keeps the captured workspace generation when a mutation reloads", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "停用" }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(3));
    expect(mocks.bindingGet).toHaveBeenCalledTimes(1);
    expect(mocks.bindingGet).toHaveBeenCalledWith("/workspace");
    for (const call of mocks.execute.mock.calls) expect(call[0]).toEqual(binding);
  });
  it("shows native revision failures without claiming a successful save", async () => {
    mocks.execute.mockImplementation((_binding, _scope, request) => request.operation === "list" ? Promise.resolve(list()) : Promise.reject("REVISION_CONFLICT"));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "忘记" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("REVISION_CONFLICT");
    expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    expect(screen.getByText("使用中文")).toBeInTheDocument();
  });
  it("requires Workspace management for global approval settings", async () => {
    open({ kind: "project", projectId: 2 });
    expect(await screen.findByRole("checkbox", { name: "自动整理需我批准" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "记忆与整理行为" })).not.toBeInTheDocument();
  });

});
