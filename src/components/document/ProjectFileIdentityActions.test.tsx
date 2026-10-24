import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProjectDirectoryFile } from "../../lib/file-types";
import { notifyProjectFilesChanged } from "../../lib/project-file-navigation";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { ProjectFileIdentityActions } from "./ProjectFileIdentityActions";

vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { resolve: vi.fn(), move: vi.fn(), rename: vi.fn(), reconcile: vi.fn(), openLocal: vi.fn() } }));
vi.mock("../../lib/project-file-navigation", () => ({ notifyProjectFilesChanged: vi.fn() }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const file: ProjectDirectoryFile = { object, relativePath: "old.txt", name: "old.txt", versionNumber: 3, contentHash: "hash3", state: "ready", reason: null };
const props = { workspaceRoot: "/workspace", projectId: 2, fileId: 7, visible: true };
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChanged = vi.fn();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrap = (next = props) => <QueryClientProvider client={client}><ProjectFileIdentityActions {...next} onChanged={onChanged} /></QueryClientProvider>;
  return { ...render(wrap()), wrap, onChanged, invalidate };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "文件位置" }));
  await screen.findByText("old.txt");
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新核对" })).toBeEnabled());
}
function target(value = "资料/new.txt") { fireEvent.change(screen.getByLabelText("同项目目标相对路径"), { target: { value } }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.resolve).mockResolvedValue(file);
  vi.mocked(projectFileApi.openLocal).mockResolvedValue(undefined);
  vi.mocked(projectFileApi.move).mockResolvedValue({ ...file, relativePath: "资料/new.txt", name: "new.txt" });
  vi.mocked(projectFileApi.rename).mockResolvedValue({ ...file, relativePath: "new.txt", name: "new.txt" });
  vi.mocked(projectFileApi.reconcile).mockResolvedValue({ ...file, relativePath: "资料/new.txt" });
});
it("opens the current File with a bound identity and does not hand historical snapshots to the local editor", async () => {
  view(); await open();
  fireEvent.click(screen.getByRole("button", { name: "在本地打开当前文件" }));
  await waitFor(() => expect(projectFileApi.openLocal).toHaveBeenCalledWith(binding, object));
  expect(projectFileApi.move).not.toHaveBeenCalled();
});
it("keeps a local-open failure visible in the File tab", async () => {
  vi.mocked(projectFileApi.openLocal).mockRejectedValue(new Error("文件已变化，请重新核对"));
  view(); await open(); fireEvent.click(screen.getByRole("button", { name: "在本地打开当前文件" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件已变化，请重新核对");
});
it("opens lazily and refreshes the real bound File rather than matching its path", async () => {
  view(); expect(recordDocumentApi.bindingGet).not.toHaveBeenCalled();
  await open();
  expect(projectFileApi.resolve).toHaveBeenCalledWith(binding, object);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ ...file, state: "missing", reason: "原位置不存在" });
  fireEvent.click(screen.getByRole("button", { name: "刷新核对" }));
  await screen.findByText("原位置不存在");
  expect(screen.getByText(/已保留的历史版本和引用仍可读取/)).toBeInTheDocument();
});
it.each(["move", "rename"] as const)("%s retains File ID/version and invalidates project, history and directory", async action => {
  const rendered = view(); await open();
  rendered.invalidate.mockClear(); rendered.onChanged.mockClear(); vi.mocked(notifyProjectFilesChanged).mockClear();
  if (action === "move") target();
  else fireEvent.change(screen.getByLabelText("新文件名"), { target: { value: "new.txt" } });
  fireEvent.click(screen.getByRole("button", { name: action === "move" ? "移动文件" : "重命名文件" }));
  await screen.findByText(action === "move" ? "资料/new.txt" : "new.txt");
  await waitFor(() => expect(rendered.onChanged).toHaveBeenCalledOnce());
  expect(projectFileApi[action]).toHaveBeenCalledWith(binding, object, action === "move" ? "资料/new.txt" : "new.txt", 3, "hash3");
  expect(screen.getByText("v3")).toBeInTheDocument();
  expect(rendered.invalidate).toHaveBeenCalledWith({ queryKey: ["project-page", 2] });
  expect(rendered.invalidate).toHaveBeenCalledWith({ queryKey: ["documentVersions", 7] });
  expect(notifyProjectFilesChanged).toHaveBeenCalledWith(2, "/workspace");
});
it("requires explicit replacement confirmation for ambiguous identity and keeps old references", async () => {
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ ...file, state: "ambiguous", reason: "Physical identity changed" });
  vi.mocked(projectFileApi.reconcile).mockResolvedValue({ ...file, versionNumber: 4, contentHash: "newhash", relativePath: "资料/new.txt" });
  view(); await open(); target();
  const submit = screen.getByRole("button", { name: "确认这是同一File的内容替换" });
  expect(submit).toBeDisabled(); fireEvent.click(submit);
  expect(projectFileApi.reconcile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /登记新的不可变版本，保留旧版本和旧引用/ }));
  fireEvent.click(submit);
  await screen.findByText("v4");
  expect(projectFileApi.reconcile).toHaveBeenCalledWith(binding, object, "资料/new.txt", 3, "hash3", "replacement");
});
it("location reconciliation passes the existing hash and reports a mismatch without replacing", async () => {
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ ...file, state: "missing", reason: "missing" });
  vi.mocked(projectFileApi.reconcile).mockRejectedValue({ code: "hash_mismatch", message: "内容不同，不能重定位" });
  view(); await open(); target();
  fireEvent.click(screen.getByRole("button", { name: "确认同一文件的新位置" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("内容不同，不能重定位");
  expect(projectFileApi.reconcile).toHaveBeenCalledWith(binding, object, "资料/new.txt", 3, "hash3", "location");
  expect(screen.getByLabelText("同项目目标相对路径")).toHaveValue("资料/new.txt");
});
it("preserves input on CAS rejection without notifications or silent retries", async () => {
  const rendered = view(); await open(); target();
  rendered.onChanged.mockClear(); rendered.invalidate.mockClear(); vi.mocked(notifyProjectFilesChanged).mockClear();
  vi.mocked(projectFileApi.move).mockRejectedValue({ code: "revision_conflict", message: "版本冲突，请刷新核对" });
  fireEvent.click(screen.getByRole("button", { name: "移动文件" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("版本冲突");
  expect(screen.getByLabelText("同项目目标相对路径")).toHaveValue("资料/new.txt");
  expect(projectFileApi.move).toHaveBeenCalledOnce();
  expect(rendered.invalidate).not.toHaveBeenCalled(); expect(rendered.onChanged).not.toHaveBeenCalled(); expect(notifyProjectFilesChanged).not.toHaveBeenCalled();
});
it("guards duplicate submissions while a mutation is pending", async () => {
  const pending = deferred<ProjectDirectoryFile>(); vi.mocked(projectFileApi.move).mockReturnValue(pending.promise);
  view(); await open(); target();
  const submit = screen.getByRole("button", { name: "移动文件" });
  fireEvent.click(submit); fireEvent.click(submit);
  await waitFor(() => expect(projectFileApi.move).toHaveBeenCalledOnce());
  await act(async () => pending.resolve(file));
});
it("does not apply an old workspace resolve to the new page", async () => {
  const pending = deferred<ProjectDirectoryFile>(); vi.mocked(projectFileApi.resolve).mockReturnValueOnce(pending.promise);
  const rendered = view(); fireEvent.click(screen.getByRole("button", { name: "文件位置" }));
  await waitFor(() => expect(projectFileApi.resolve).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...props, workspaceRoot: "/new", projectId: 8, fileId: 9 }));
  await act(async () => pending.resolve(file));
  expect(screen.queryByText("old.txt")).not.toBeInTheDocument();
  expect(rendered.onChanged).not.toHaveBeenCalled(); expect(notifyProjectFilesChanged).not.toHaveBeenCalled();
});
it("does not publish a hidden tab's late mutation result", async () => {
  const pending = deferred<ProjectDirectoryFile>(); vi.mocked(projectFileApi.move).mockReturnValue(pending.promise);
  const rendered = view(); await open(); target(); rendered.onChanged.mockClear(); rendered.invalidate.mockClear(); vi.mocked(notifyProjectFilesChanged).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "移动文件" }));
  await waitFor(() => expect(projectFileApi.move).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...props, visible: false }));
  await act(async () => pending.resolve({ ...file, relativePath: "late.txt" }));
  expect(rendered.invalidate).not.toHaveBeenCalled(); expect(rendered.onChanged).not.toHaveBeenCalled();
  rendered.rerender(rendered.wrap(props));
  await screen.findByText("old.txt"); expect(screen.queryByText("late.txt")).not.toBeInTheDocument();
});
it("rejects a generation change before submitting and after resolving", async () => {
  view(); await open(); target();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ ...binding, generation: "new" });
  fireEvent.click(screen.getByRole("button", { name: "移动文件" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("代次已变化");
  expect(projectFileApi.move).not.toHaveBeenCalled();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValueOnce(binding).mockResolvedValue({ ...binding, generation: "new" });
  fireEvent.click(screen.getByRole("button", { name: "刷新核对" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("代次已变化");
  expect(screen.queryByText("old.txt")).not.toBeInTheDocument();
});
it("rejects a mutation result from an obsolete generation", async () => {
  const pending = deferred<ProjectDirectoryFile>(); vi.mocked(projectFileApi.move).mockReturnValue(pending.promise);
  const rendered = view(); await open(); target(); rendered.invalidate.mockClear(); rendered.onChanged.mockClear(); vi.mocked(notifyProjectFilesChanged).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "移动文件" }));
  await waitFor(() => expect(projectFileApi.move).toHaveBeenCalledOnce());
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ ...binding, generation: "new" });
  await act(async () => pending.resolve({ ...file, relativePath: "obsolete.txt" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("代次已变化");
  expect(screen.queryByText("obsolete.txt")).not.toBeInTheDocument();
  expect(rendered.invalidate).not.toHaveBeenCalled(); expect(rendered.onChanged).not.toHaveBeenCalled(); expect(notifyProjectFilesChanged).not.toHaveBeenCalled();
});
it("cancels late binding acquisition when the panel closes", async () => {
  const pending = deferred<typeof binding>(); vi.mocked(recordDocumentApi.bindingGet).mockReturnValueOnce(pending.promise);
  view(); fireEvent.click(screen.getByRole("button", { name: "文件位置" }));
  await waitFor(() => expect(recordDocumentApi.bindingGet).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "文件位置" }));
  await act(async () => pending.resolve(binding));
  expect(projectFileApi.resolve).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "文件位置核对" })).not.toBeInTheDocument();
});
it("reports unavailable snapshot budget without claiming a new version", async () => {
  view(); await open(); target();
  vi.mocked(projectFileApi.move).mockResolvedValue({ ...file, state: "unavailable", reason: "File exceeds the existing 100 MiB snapshot budget; version is not registered" });
  fireEvent.click(screen.getByRole("button", { name: "移动文件" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("version is not registered");
  expect(screen.getByText("v3")).toBeInTheDocument();
  expect(screen.queryByText("v4")).not.toBeInTheDocument();
});
it("reports native boundary/read failures and rejects wrong object ownership", async () => {
  vi.mocked(projectFileApi.resolve).mockRejectedValueOnce({ code: "io_error", message: "读取失败" });
  view(); fireEvent.click(screen.getByRole("button", { name: "文件位置" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ ...file, object: { ...object, id: "99" } });
  fireEvent.click(screen.getByRole("button", { name: "刷新核对" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("身份或项目归属不符");
  expect(screen.queryByText("old.txt")).not.toBeInTheDocument();
});

it("moves a Workspace File with the same CAS checks and only refreshes its real owner", async () => {
  const workspaceObject = { ...object, scope: { kind: "workspace" as const } };
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ ...file, object: workspaceObject });
  vi.mocked(projectFileApi.move).mockResolvedValue({ ...file, object: workspaceObject, relativePath: "资料/new.txt", name: "new.txt" });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><ProjectFileIdentityActions {...props} projectId={null} /></QueryClientProvider>);
  await open();
  fireEvent.change(screen.getByLabelText("同工作区目标相对路径"), { target: { value: "资料/new.txt" } });
  fireEvent.click(screen.getByRole("button", { name: "移动文件" }));
  await screen.findByText("资料/new.txt");
  expect(projectFileApi.move).toHaveBeenCalledWith(binding, workspaceObject, "资料/new.txt", 3, "hash3");
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspace-page"] });
  expect(notifyProjectFilesChanged).toHaveBeenCalledWith(null, "/workspace");
});
