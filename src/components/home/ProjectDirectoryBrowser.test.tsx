import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { projectFileApi } from "../../services/projectFileApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { queryKeys } from "../../lib/queryKeys";
import { HomeProjectFiles } from "./HomeProjectFiles";
import { projectDirectoryApi, type ProjectDirectoryEntry } from "../../services/projectDirectoryApi";

vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { list: vi.fn(), preview: vi.fn(), open: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { scan: vi.fn() } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../layout/ProjectSidebar", () => ({ ProjectSidebar: () => <div>已登记文档</div> }));
const folder: ProjectDirectoryEntry = { name: "generated", relativePath: "generated", kind: "directory", bytes: 0 };
const file: ProjectDirectoryEntry = { name: "result.txt", relativePath: "generated/result.txt", kind: "file", bytes: 20 };
const project = { id: 7, name: "Project", rootPath: "/project" };
function panel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace" } });
  const wrap = (id: number) => <QueryClientProvider client={client}><HomeProjectFiles project={{ ...project, id }} documents={[]} /></QueryClientProvider>;
  return { ...render(wrap(7)), client, wrap };
}
function directoryTab() { fireEvent.click(screen.getByRole("tab", { name: "项目目录" })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.resetAllMocks();
  useProjectFileNavigation.setState({ request: null, revisions: {} });
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ workspaceId: "w", generation: "g" });
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, relative) => relative === "generated" ? [file] : [folder]);
  vi.mocked(projectDirectoryApi.preview).mockResolvedValue({ kind: "text", text: "generated content", bytes: 20 });
  vi.mocked(projectDirectoryApi.open).mockResolvedValue(undefined);
});

it("keeps managed Files available and navigates the physical tree, breadcrumbs and refresh", async () => {
  panel();
  expect(screen.getByText("已登记文档")).toBeVisible();
  expect(projectDirectoryApi.list).not.toHaveBeenCalled();
  directoryTab();
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  await screen.findByRole("button", { name: /result.txt/ });
  expect(projectDirectoryApi.list).toHaveBeenLastCalledWith(7, "generated");
  const region = screen.getByRole("region", { name: "项目目录内容" });
  expect(region.parentElement).toHaveClass("home-side__list-frame");
  fireEvent.click(screen.getByRole("button", { name: "刷新项目目录" }));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(3));
  fireEvent.click(within(screen.getByRole("navigation", { name: "项目目录路径" })).getByRole("button", { name: "项目根目录" }));
  await screen.findByRole("button", { name: "generated" });
  expect(projectDirectoryApi.list).toHaveBeenLastCalledWith(7, "");
  fireEvent.click(screen.getByRole("tab", { name: "已管理文件" }));
  expect(screen.getByText("已登记文档")).toBeVisible();
});

it("routes physical files to the unified identity preview without reading an independent dialog", async () => {
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([file]);
  panel(); directoryTab();
  fireEvent.click(await screen.findByRole("button", { name: /result.txt/ }));
  expect(useProjectFileNavigation.getState().request).toMatchObject({ projectId: 7, path: "generated/result.txt" });
  expect(projectDirectoryApi.preview).not.toHaveBeenCalled();
  expect(projectDirectoryApi.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows real filesystem errors and retries directory listing", async () => {
  vi.mocked(projectDirectoryApi.list).mockRejectedValueOnce(new Error("项目根目录不存在"));
  panel(); directoryTab();
  expect(await screen.findByRole("alert")).toHaveTextContent("项目根目录不存在");
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([file]);
  fireEvent.click(screen.getByRole("button", { name: "刷新项目目录" }));
  expect(await screen.findByRole("button", { name: /result.txt/ })).toBeVisible();
});

it("remounts on project changes and ignores an old directory response", async () => {
  const stale = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(stale.promise);
  const view = panel(); directoryTab();
  view.rerender(view.wrap(8));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenLastCalledWith(8, ""));
  await act(async () => stale.resolve([file]));
  expect(screen.queryByRole("button", { name: /result.txt/ })).toBeNull();
  expect(screen.getByRole("button", { name: "项目根目录" })).toHaveAttribute("aria-current", "page");
});

it("ignores a pending directory response after switching back to managed Files", async () => {
  const stale = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValue(stale.promise);
  panel(); directoryTab();
  fireEvent.click(screen.getByRole("tab", { name: "已管理文件" }));
  await act(async () => { stale.resolve([file]); });
  expect(screen.queryByRole("button", { name: /result.txt/ })).toBeNull();
  expect(screen.getByText("已登记文档")).toBeVisible();
});

const registered = { object: { workspaceId: "w", scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "4" }, relativePath: "result.txt", name: "result.txt", versionNumber: 1, contentHash: "sha256:known", state: "ready" as const, reason: null };
it("scans bounded pages and displays failed and excluded rows without discarding successful Files", async () => {
  vi.mocked(projectFileApi.scan).mockResolvedValueOnce({ files: [registered], failures: [{ relativePath: "bad", reason: "unreadable" }], excluded: [{ relativePath: "link", reason: "symlink" }], nextCursor: "next", complete: false, cancelled: false })
    .mockResolvedValueOnce({ files: [], failures: [], excluded: [], nextCursor: null, complete: true, cancelled: false });
  const view = panel(); directoryTab();
  const invalidated = vi.spyOn(view.client, "invalidateQueries");
  fireEvent.click(screen.getByRole("button", { name: "纳管整个目录" }));
  expect(await screen.findByText(/纳管完成：1 个 File/)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/纳管完成：1 个 File/));
  expect(screen.getByText("bad：unreadable")).toBeVisible();
  expect(screen.getByText("link：符号链接")).toBeVisible();
  expect(projectFileApi.scan).toHaveBeenNthCalledWith(2, { workspaceId: "w", generation: "g" }, 7, "next");
  expect(invalidated).toHaveBeenCalledWith({ queryKey: queryKeys.projectPage(7) });
});
it("cancel stops further pages and preserves the completed registration page", async () => {
  const pending = deferred<Awaited<ReturnType<typeof projectFileApi.scan>>>();
  vi.mocked(projectFileApi.scan).mockReturnValueOnce(pending.promise);
  panel(); directoryTab(); fireEvent.click(screen.getByRole("button", { name: "纳管整个目录" }));
  await waitFor(() => expect(projectFileApi.scan).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await act(async () => pending.resolve({ files: [registered], failures: [], excluded: [], nextCursor: "next", complete: false, cancelled: false }));
  expect(screen.getByText(/已取消：1 个 File/)).toBeInTheDocument();
  expect(projectFileApi.scan).toHaveBeenCalledOnce();
});

it("pauses a retained failing directory cursor and explicitly retries after repair", async () => {
  const blocked = { files: [registered], failures: [{ relativePath: "blocked", reason: "Permission denied" }], excluded: [], nextCursor: "blocked-cursor", complete: false, cancelled: false };
  vi.mocked(projectFileApi.scan).mockResolvedValueOnce(blocked)
    .mockResolvedValueOnce({ ...blocked, files: [] })
    .mockResolvedValueOnce({ files: [registered], failures: [], excluded: [], nextCursor: null, complete: true, cancelled: false });
  panel(); directoryTab();
  fireEvent.click(screen.getByRole("button", { name: "纳管整个目录" }));
  const summary = await screen.findByText(/纳管未完成：1 个 File，1 项失败/);
  expect(projectFileApi.scan).toHaveBeenCalledTimes(2);
  fireEvent.click(summary);
  expect(screen.getByText("blocked：Permission denied")).toBeVisible();
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "纳管整个目录" }));
  expect(await screen.findByText(/纳管完成：1 个 File，0 项失败/)).toBeInTheDocument();
  expect(projectFileApi.scan).toHaveBeenNthCalledWith(3, { workspaceId: "w", generation: "g" }, 7, null);
});
