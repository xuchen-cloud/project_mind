import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { HomeProjectFiles } from "./HomeProjectFiles";
import { projectDirectoryApi, type ProjectDirectoryEntry } from "../../services/projectDirectoryApi";

vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { list: vi.fn() } }));
vi.mock("../layout/ProjectSidebar", () => ({ ProjectSidebar: ({ fileHeaderActions, fileContent, fileFilter }: { fileHeaderActions?: ReactNode; fileContent?: ReactNode; fileFilter?: { query: string; tagId: number | null } }) => <div><div>{fileHeaderActions}</div>{fileContent ?? <div>平铺文件：{fileFilter?.query}:{fileFilter?.tagId}</div>}</div> }));
const folder: ProjectDirectoryEntry = { name: "generated", relativePath: "generated", kind: "directory", bytes: 0 };
const file: ProjectDirectoryEntry = { name: "result.txt", relativePath: "generated/result.txt", kind: "file", bytes: 20 };
const project = { id: 7, name: "Project", rootPath: "/project" };
function panel(filter = { query: "", tagId: null as number | null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (id: number) => <QueryClientProvider client={client}><HomeProjectFiles project={{ ...project, id }} documents={[]} filter={filter} /></QueryClientProvider>;
  return { ...render(wrap(7)), client, wrap };
}
function tree() { fireEvent.click(screen.getByRole("button", { name: "文件树展示" })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.resetAllMocks();
  useProjectFileNavigation.setState({ request: null, revisions: {} });
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, relative) => relative === "generated" ? [file] : [folder]);
});

it("switches presentation with an icon and ignores filters only in the tree", async () => {
  panel({ query: "不匹配", tagId: 42 });
  expect(screen.getByText("平铺文件：不匹配:42")).toBeVisible();
  const toggle = screen.getByRole("button", { name: "文件树展示" });
  expect(toggle).toHaveTextContent("");
  expect(screen.queryByRole("tab", { name: "已管理文件" })).toBeNull();
  tree();
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  expect(await screen.findByRole("button", { name: /result.txt/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "generated" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", { name: "纳管整个目录" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "平铺展示" }));
  expect(screen.getByText("平铺文件：不匹配:42")).toBeVisible();
});

it("expands nested folders in place and opens files through unified File navigation", async () => {
  panel(); tree();
  const folderButton = await screen.findByRole("button", { name: "generated" });
  fireEvent.click(folderButton);
  fireEvent.click(await screen.findByRole("button", { name: /result.txt/ }));
  expect(useProjectFileNavigation.getState().request).toMatchObject({ projectId: 7, path: "generated/result.txt" });
  expect(folderButton).toBeVisible();
  fireEvent.click(folderButton);
  expect(screen.queryByRole("button", { name: /result.txt/ })).toBeNull();
  const region = screen.getByRole("region", { name: "项目目录内容" });
  expect(region.parentElement).toHaveClass("home-side__list-frame");
});

it("shows a real directory read error and retries that folder", async () => {
  vi.mocked(projectDirectoryApi.list).mockRejectedValueOnce(new Error("项目根目录不存在"));
  panel(); tree();
  expect(await screen.findByRole("alert")).toHaveTextContent("项目根目录不存在");
  fireEvent.click(screen.getByRole("button", { name: "重试读取目录" }));
  expect(await screen.findByRole("button", { name: "generated" })).toBeVisible();
});

it("scopes hierarchy guides to expanded branches and removes them on collapse", async () => {
  const nestedFolder = { ...folder, name: "nested", relativePath: "generated/nested" };
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) =>
    path === "" ? [folder] : path === "generated" ? [nestedFolder] : [file]);
  const view = panel(); tree();
  const root = await screen.findByRole("button", { name: "generated" });
  expect(view.container.querySelector(".project-directory__children")).toBeNull();
  fireEvent.click(root);
  const nested = await screen.findByRole("button", { name: "nested" });
  const rootChildren = nested.closest(".project-directory__children")!;
  expect(rootChildren).toBeVisible();
  fireEvent.click(nested);
  const leaf = await screen.findByRole("button", { name: /result.txt/ });
  const nestedChildren = leaf.closest(".project-directory__children")!;
  expect(nestedChildren).not.toBe(rootChildren);
  expect(rootChildren).toContainElement(nestedChildren);
  fireEvent.click(nested);
  expect(nestedChildren).not.toBeInTheDocument();
  expect(rootChildren).toBeVisible();
  fireEvent.click(root);
  expect(view.container.querySelector(".project-directory__children")).toBeNull();
});

it("ignores stale directory replies after switching project or presentation", async () => {
  const stale = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(stale.promise);
  const view = panel(); tree();
  view.rerender(view.wrap(8));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenLastCalledWith(8, ""));
  await act(async () => stale.resolve([file]));
  expect(screen.queryByRole("button", { name: /result.txt/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "平铺展示" }));
  expect(screen.getByText("平铺文件：:")).toBeVisible();
});

it("refreshes expanded directories after external files are copied in", async () => {
  const view = panel(); tree();
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  await screen.findByRole("button", { name: /result.txt/ });
  const copied = { ...file, name: "copied.md", relativePath: "generated/copied.md" };
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) => path === "generated" ? [file, copied] : [folder]);
  await act(async () => { await view.client.invalidateQueries(); });
  expect(await screen.findByRole("button", { name: /copied.md/ })).toBeVisible();
  expect(within(screen.getByRole("region", { name: "项目目录内容" })).getByRole("button", { name: "generated" })).toBeVisible();
});
