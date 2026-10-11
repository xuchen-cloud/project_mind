import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HomeProjectFiles } from "./HomeProjectFiles";
import { projectDirectoryApi, type ProjectDirectoryEntry, type ProjectDirectoryPreview } from "../../services/projectDirectoryApi";

vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { list: vi.fn(), preview: vi.fn(), open: vi.fn() } }));
vi.mock("../layout/ProjectSidebar", () => ({ ProjectSidebar: () => <div>已登记文档</div> }));
const folder: ProjectDirectoryEntry = { name: "generated", relativePath: "generated", kind: "directory", bytes: 0 };
const file: ProjectDirectoryEntry = { name: "result.txt", relativePath: "generated/result.txt", kind: "file", bytes: 20 };
const project = { id: 7, name: "Project", rootPath: "/project" };
function panel() { return render(<HomeProjectFiles project={project} documents={[]} />); }
function directoryTab() { fireEvent.click(screen.getByRole("tab", { name: "项目目录" })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.resetAllMocks();
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

it("previews text safely in the main dialog and opens unsupported files through the guarded command", async () => {
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([file]);
  vi.mocked(projectDirectoryApi.preview).mockResolvedValue({ kind: "text", text: "<svg><script>unsafe()</script></svg>", bytes: 40 });
  panel(); directoryTab();
  fireEvent.click(await screen.findByRole("button", { name: /result.txt/ }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("<svg><script>unsafe()</script></svg>")).toBeVisible();
  expect(dialog.querySelector("script")).toBeNull();
  expect(dialog.querySelector("img")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭对话框" }));
  vi.mocked(projectDirectoryApi.preview).mockResolvedValue({ kind: "open", reason: "tooLarge", bytes: 3_000_000 });
  fireEvent.click(screen.getByRole("button", { name: /result.txt/ }));
  expect(await screen.findByText("文件超过预览大小限制，请在本地应用打开。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "在本地应用打开" }));
  await waitFor(() => expect(projectDirectoryApi.open).toHaveBeenCalledWith(7, "generated/result.txt"));
});

it("shows real filesystem errors and uses raster base64 for image previews", async () => {
  vi.mocked(projectDirectoryApi.list).mockRejectedValueOnce(new Error("项目根目录不存在"));
  panel(); directoryTab();
  expect(await screen.findByRole("alert")).toHaveTextContent("项目根目录不存在");
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([file]);
  vi.mocked(projectDirectoryApi.preview).mockResolvedValue({ kind: "image", mime: "image/png", base64: "fixture", bytes: 6 });
  fireEvent.click(screen.getByRole("button", { name: "刷新项目目录" }));
  fireEvent.click(await screen.findByRole("button", { name: /result.txt/ }));
  expect(await screen.findByRole("img", { name: "result.txt" })).toHaveAttribute("src", "data:image/png;base64,fixture");
  vi.mocked(projectDirectoryApi.open).mockRejectedValue(new Error("文件已移动"));
  fireEvent.click(screen.getByRole("button", { name: "在本地应用打开" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件已移动");
});

it("remounts the directory browser on project changes and ignores the old preview response", async () => {
  const stale = deferred<ProjectDirectoryPreview>();
  vi.mocked(projectDirectoryApi.preview).mockReturnValue(stale.promise);
  const view = panel(); directoryTab();
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.click(await screen.findByRole("button", { name: /result.txt/ }));
  await screen.findByRole("dialog");
  view.rerender(<HomeProjectFiles project={{ ...project, id: 8 }} documents={[]} />);
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenLastCalledWith(8, ""));
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { stale.resolve({ kind: "text", text: "old project secret", bytes: 20 }); });
  expect(screen.queryByText("old project secret")).toBeNull();
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
