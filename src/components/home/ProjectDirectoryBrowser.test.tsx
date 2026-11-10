import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectFileMenuControls } from "../layout/ProjectSidebar";
import type { ReactNode } from "react";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { ProjectDirectoryBrowser } from "./ProjectDirectoryBrowser";
import { HomeProjectFiles } from "./HomeProjectFiles";
import { projectDirectoryApi, type ProjectDirectoryEntry } from "../../services/projectDirectoryApi";

const native = vi.hoisted(() => ({binding:vi.fn(),listen:vi.fn()}));
const fileActions = vi.hoisted(() => ({ register: vi.fn(), projectPage: vi.fn(), workspacePage: vi.fn() }));
const trashActions = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn(), busy: false }));
vi.mock("./useNavigationTrash", () => ({ useNavigationTrash: () => ({ capture: trashActions.capture, busy: trashActions.busy }) }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { register: fileActions.register } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { projectPageGet: fileActions.projectPage, workspacePageGet: fileActions.workspacePage } }));
vi.mock("../../services/recordDocumentApi", () => ({recordDocumentApi:{bindingGet:native.binding}}));
vi.mock("../../services/desktopApi", () => ({desktopApi:{listenEvent:native.listen}}));
afterEach(() => { Reflect.deleteProperty(window,"__TAURI_INTERNALS__"); });
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { list: vi.fn() } }));
vi.mock("../layout/ProjectSidebar", () => ({ ProjectSidebar: ({ fileHeaderActions, fileContent, fileFilter, documents }: { documents?: { id: number }[]; fileHeaderActions?: ReactNode; fileContent?: ReactNode | ((controls: ProjectFileMenuControls) => ReactNode); fileFilter?: { query: string; tagId: number | null } }) => <div><span data-testid="visible-file-ids">{documents?.map(item => item.id).join(",")}</span><div>{fileHeaderActions}</div>{(typeof fileContent === "function" ? fileContent({ openContextMenu: vi.fn(), renderRenameInput: () => null }) : fileContent) ?? <div>平铺文件：{fileFilter?.query}:{fileFilter?.tagId}</div>}</div> }));
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

function watchedDirectory() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  const binding = { workspaceId: "w", generation: "g" };
  native.binding.mockResolvedValue(binding);
  const listeners: ((hint: { binding: typeof binding; projectId: number; relativePaths?: string[] | null }) => void)[] = [];
  native.listen.mockImplementation(async (_name, callback) => { listeners.push(callback); return vi.fn(); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (id = 7, hidden = false, documents: import("../layout/ProjectSidebar").ProjectSidebarDocumentItem[] = []) => <div hidden={hidden}><QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={id} workspaceRoot="/workspace" rootPath={`/project-${id}`} documents={documents} /></QueryClientProvider></div>;
  const view = render(wrap());
  return { ...view, client, wrap, listeners, dirty: () => listeners[0]({ binding, projectId: 7, relativePaths: [""] }) };
}

function directoryWithDocuments() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (documents: import("../layout/ProjectSidebar").ProjectSidebarDocumentItem[] = [], hidden = false, id = 7) =>
    <div hidden={hidden}><QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={id} rootPath="/project" documents={documents} /></QueryClientProvider></div>;
  const view = render(wrap());
  const imported = { id: 1, managedPath: "/project/imported.txt" } as import("../layout/ProjectSidebar").ProjectSidebarDocumentItem;
  return { ...view, client, wrap, imported };
}

it("merges native and documents changes into one fresh read while an older read is pending", async () => {
  const old = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = watchedDirectory();
  await waitFor(() => expect(view.listeners).toHaveLength(1));
  await act(async () => { view.dirty(); });
  const imported = { id: 1, managedPath: "/project-7/imported.txt" } as import("../layout/ProjectSidebar").ProjectSidebarDocumentItem;
  view.rerender(view.wrap(7, false, [imported]));
  await act(async () => { window.dispatchEvent(new Event("focus")); view.dirty(); });
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([{ ...file, name: "merged.txt", relativePath: "merged.txt" }]);
  await act(async () => { old.resolve([folder]); });
  expect(await screen.findByRole("button", { name: "merged.txt" })).toBeVisible();
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
});

it.each(["initial", "existing"])("does not fan focus out over an %s read", async mode => {
  const old = deferred<ProjectDirectoryEntry[]>();
  if (mode === "initial") vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = directoryWithDocuments();
  if (mode === "existing") {
    await screen.findByRole("button", { name: "generated" });
    vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
    act(() => { void view.client.refetchQueries({ queryKey: ["project-directory"] }); });
  }
  const before = mode === "initial" ? 1 : 2;
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before));
  await act(async () => { window.dispatchEvent(new Event("focus")); old.resolve([folder]); });
  expect(await screen.findByRole("button", { name: "generated" })).toBeVisible();
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before);
});

it.each([false, true])("reconciles documents membership during an old read (hidden=%s)", async hidden => {
  const old = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = directoryWithDocuments();
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1));
  view.rerender(view.wrap([view.imported], hidden));
  await act(async () => {});
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([{ ...file, name: "imported.txt", relativePath: "imported.txt" }]);
  await act(async () => { old.resolve([folder]); });
  if (hidden) {
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
    view.rerender(view.wrap([view.imported]));
  }
  expect(await screen.findByRole("button", { name: "imported.txt" })).toBeVisible();
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
});

it.each(["documents"].flatMap(source => ["unmount", "scope"].map(change => ({ source, change }))))("disposes $source refresh coordination on $change", async ({ source, change }) => {
  const old = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = directoryWithDocuments();
  const invalidation = vi.spyOn(view.client, "invalidateQueries");
  await act(async () => {
    if (source === "focus") window.dispatchEvent(new Event("focus"));
    else view.rerender(view.wrap([view.imported]));
  });
  if (change === "unmount") view.unmount();
  else {
    vi.mocked(projectDirectoryApi.list).mockResolvedValue([folder]);
    view.rerender(view.wrap([], false, 8));
    await screen.findByRole("button", { name: "generated" });
  }
  await act(async () => { old.resolve([folder]); });
  expect(invalidation).not.toHaveBeenCalled();
  expect(projectDirectoryApi.list.mock.calls).toEqual(change === "unmount" ? [[7, ""]] : [[7, ""], [8, ""]]);
});

it.each(["initial", "refresh"].flatMap(mode => [false, true].map(burst => ({ mode, burst }))))("keeps dirty during $mode read (burst=$burst) until a fresh snapshot is read", async ({ mode, burst }) => {
  const old = deferred<ProjectDirectoryEntry[]>();
  const fresh = { ...folder, name: "fresh", relativePath: "fresh" };
  if (mode === "initial") vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = watchedDirectory();
  await waitFor(() => expect(view.listeners).toHaveLength(1));
  if (mode === "refresh") {
    await screen.findByRole("button", { name: "generated" });
    vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
    act(() => { void view.client.refetchQueries({ queryKey: ["project-directory"] }); });
  }
  const before = mode === "initial" ? 1 : 2;
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before));
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([fresh]);
  await act(async () => { view.dirty(); });
  // A later burst while the old native I/O is still pending belongs to the same refresh.
  if (burst) await act(async () => { view.dirty(); view.dirty(); });
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before);
  await act(async () => { old.resolve([folder]); });
  expect(await screen.findByRole("button", { name: "fresh" })).toBeVisible();
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before + 1);
});

it.each(["initial", "refresh"])("defers dirty received during %s I/O when hidden before it settles", async mode => {
  const old = deferred<ProjectDirectoryEntry[]>();
  if (mode === "initial") vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = watchedDirectory();
  await waitFor(() => expect(view.listeners).toHaveLength(1));
  if (mode === "refresh") {
    await screen.findByRole("button", { name: "generated" });
    vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
    act(() => { void view.client.refetchQueries({ queryKey: ["project-directory"] }); });
  }
  const before = mode === "initial" ? 1 : 2;
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before));
  await act(async () => { view.dirty(); });
  view.rerender(view.wrap(7, true));
  await act(async () => {});
  const fresh = { ...folder, name: "after-show", relativePath: "after-show" };
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([fresh]);
  await act(async () => { old.resolve([folder]); });
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before);
  view.rerender(view.wrap());
  expect(await screen.findByRole("button", { name: "after-show" })).toBeVisible();
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before + 1);
});

it.each(["unmount", "scope switch"])("disposes a dirty wait on %s without refreshing its old or new scope", async change => {
  const old = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = watchedDirectory();
  await waitFor(() => expect(view.listeners).toHaveLength(1));
  await act(async () => { view.dirty(); });
  const fresh = { ...folder, name: "new-scope", relativePath: "new-scope" };
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([fresh]);
  if (change === "unmount") view.unmount();
  else {
    view.rerender(view.wrap(8));
    await screen.findByRole("button", { name: "new-scope" });
  }
  await act(async () => { old.resolve([folder]); view.dirty(); });
  expect(projectDirectoryApi.list.mock.calls).toEqual(change === "unmount" ? [[7, ""]] : [[7, ""], [8, ""]]);
  expect(screen.queryByRole("button", { name: "generated" })).toBeNull();
  if (change !== "unmount") expect(screen.getByRole("button", { name: "new-scope" })).toBeVisible();
});

beforeEach(() => {
  vi.resetAllMocks();
  trashActions.busy = false;
  trashActions.capture.mockReturnValue(trashActions.run);
  trashActions.run.mockResolvedValue(undefined);
  useProjectFileNavigation.setState({ request: null, revisions: {} });
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, relative) => relative === "generated" ? [file] : [folder]);
});

it("selects visible file/folder ranges across expanded branches without previewing or expanding modifier clicks", async () => {
  const sibling = { ...folder, name: "other", relativePath: "other" };
  const tail = { ...file, name: "z.txt", relativePath: "z.txt" };
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) => path === "generated" ? [file] : [folder, sibling, tail]);
  directoryWithDocuments();
  const user = userEvent.setup();
  const generated = await screen.findByRole("button", { name: "generated" });
  await user.click(generated);
  const leaf = await screen.findByRole("button", { name: "result.txt" });
  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("button", { name: "z.txt" }));
  expect(screen.getAllByRole("button", { pressed: true }).map(node => node.getAttribute("aria-label"))).toEqual(["generated", "result.txt", "other", "z.txt"]);
  await user.click(screen.getByRole("button", { name: "other" }));
  expect(screen.getAllByRole("button", { pressed: true }).map(node => node.getAttribute("aria-label"))).toEqual(["generated", "result.txt", "other"]);
  expect(screen.getByRole("button", { name: "other" })).toHaveAttribute("aria-expanded", "false");
  await user.click(leaf);
  await user.keyboard("{/Shift}");
  expect(useProjectFileNavigation.getState().request).toBeNull();
  await user.click(leaf);
  expect(useProjectFileNavigation.getState().request).toMatchObject({ path: "generated/result.txt" });
});

it.each(["Control", "Meta"])("toggles with %s and captures selected folders and files for the shared bulk menu", async modifier => {
  const view = directoryWithDocuments();
  const user = userEvent.setup();
  const generated = await screen.findByRole("button", { name: "generated" });
  await user.click(generated);
  const leaf = await screen.findByRole("button", { name: "result.txt" });
  await user.keyboard(`{${modifier}>}`);
  await user.click(leaf);
  await user.click(generated);
  await user.click(generated);
  expect(generated).toHaveAttribute("aria-expanded", "true");
  await user.keyboard(`{/${modifier}}`);
  fireEvent.contextMenu(generated);
  expect(trashActions.capture).toHaveBeenCalledWith([
    { key: "directory:generated", relativePath: "generated", kind: "directory" },
    { key: "file:generated/result.txt", relativePath: "generated/result.txt", kind: "file" },
  ]);
  expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  expect(screen.getByRole("menuitem", { name: "删除所选 2 项" })).toBeVisible();
  const captured = trashActions.run;
  trashActions.capture.mockReturnValue(vi.fn());
  view.rerender(view.wrap());
  fireEvent.click(screen.getByRole("menuitem", { name: "删除所选 2 项" }));
  await waitFor(() => expect(captured).toHaveBeenCalledOnce());
  expect(generated).toHaveAttribute("aria-pressed", "true");
  expect(leaf).toHaveAttribute("aria-pressed", "true");
});

it("removes successful folders and selected descendants while retaining failed siblings", async () => {
  const sibling = { ...folder, name: "failed", relativePath: "failed" };
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) => path === "generated" ? [file] : [folder, sibling]);
  directoryWithDocuments();
  const generated = await screen.findByRole("button", { name: "generated" });
  fireEvent.click(generated);
  const leaf = await screen.findByRole("button", { name: "result.txt" });
  const failed = screen.getByRole("button", { name: "failed" });
  fireEvent.click(failed, { shiftKey: true });
  fireEvent.contextMenu(leaf);
  trashActions.run.mockResolvedValue({ succeeded: [{ key: "directory:generated", relativePath: "generated", kind: "directory" }],
    failed: [{ item: { key: "directory:failed", relativePath: "failed", kind: "directory" }, message: "busy" }] });
  fireEvent.click(screen.getByRole("menuitem", { name: "删除所选 3 项" }));
  await waitFor(() => expect(generated).toHaveAttribute("aria-pressed", "false"));
  expect(leaf).toHaveAttribute("aria-pressed", "false");
  expect(failed).toHaveAttribute("aria-pressed", "true");
});

it("uses the original single-item menu after right-clicking an unselected file", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const standalone = { ...file, name: "standalone.txt", relativePath: "standalone.txt" };
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) => path === "generated" ? [file] : [folder, standalone]);
  const document = { id: 2, managedPath: "/project/standalone.txt" } as import("../layout/ProjectSidebar").ProjectSidebarDocumentItem;
  const fileMenu = { openContextMenu: vi.fn(), renderRenameInput: () => null };
  render(<QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} rootPath="/project" documents={[document]} fileMenu={fileMenu} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.click(await screen.findByRole("button", { name: "result.txt" }), { ctrlKey: true });
  fireEvent.contextMenu(screen.getByRole("button", { name: "standalone.txt" }));
  await waitFor(() => expect(fileMenu.openContextMenu).toHaveBeenCalledWith(document, 0, 0));
  expect(screen.getAllByRole("button", { pressed: true })).toEqual([screen.getByRole("button", { name: "standalone.txt" })]);
  expect(trashActions.capture).not.toHaveBeenCalled();
});

it("prunes collapsed descendants and external deletions, and clears selection/menu on owner change", async () => {
  const view = directoryWithDocuments();
  const generated = await screen.findByRole("button", { name: "generated" });
  fireEvent.click(generated);
  const leaf = await screen.findByRole("button", { name: "result.txt" });
  fireEvent.click(leaf, { ctrlKey: true });
  fireEvent.click(generated);
  fireEvent.click(generated, { ctrlKey: true });
  await waitFor(() => expect(screen.queryByRole("button", { pressed: true })).toBeNull());
  fireEvent.click(generated);
  fireEvent.click(await screen.findByRole("button", { name: "result.txt" }), { ctrlKey: true });
  fireEvent.contextMenu(generated);
  expect(screen.getByRole("menuitem", { name: "删除所选 2 项" })).toBeVisible();
  view.rerender(view.wrap([], false, 8));
  await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  expect(await screen.findByRole("button", { name: "generated" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "generated" }), { ctrlKey: true });
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([]);
  await act(async () => { await view.client.invalidateQueries({ queryKey: ["project-directory", "/project", 8] }); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "generated" })).toBeNull());
  expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([folder]);
  await act(async () => { await view.client.invalidateQueries({ queryKey: ["project-directory", "/project", 8] }); });
  expect(await screen.findByRole("button", { name: "generated" })).toHaveAttribute("aria-pressed", "false");
});

it("protects inline rename drafts and busy operations from bulk deletion", async () => {
  const standalone = { ...file, name: "draft.txt", relativePath: "draft.txt" };
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) => path === "generated" ? [file] : [folder, standalone]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renaming = true;
  const fileMenu = { openContextMenu: vi.fn(), busy: false, renaming: false, renderRenameInput: (path: string) => renaming && path === "draft.txt" ? <input aria-label="rename draft" defaultValue="unsaved" /> : null };
  const wrap = () => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} rootPath="/project" fileMenu={fileMenu} /></QueryClientProvider>;
  const view = render(wrap());
  const generated = await screen.findByRole("button", { name: "generated" });
  fireEvent.click(generated);
  const leaf = await screen.findByRole("button", { name: "result.txt" });
  fireEvent.click(leaf, { ctrlKey: true });
  fireEvent.contextMenu(generated);
  expect(screen.queryByRole("menuitem")).toBeNull();
  expect(screen.getByRole("textbox", { name: "rename draft" })).toHaveValue("unsaved");
  expect(trashActions.capture).not.toHaveBeenCalled();
  renaming = false;
  fileMenu.renaming = true;
  view.rerender(wrap());
  fireEvent.contextMenu(generated);
  expect(trashActions.capture).not.toHaveBeenCalled();
  fileMenu.renaming = false;
  fileMenu.busy = true;
  view.rerender(wrap());
  fireEvent.contextMenu(generated);
  expect(trashActions.capture).not.toHaveBeenCalled();
  fileMenu.busy = false;
  trashActions.busy = true;
  view.rerender(wrap());
  fireEvent.contextMenu(generated);
  expect(trashActions.capture).not.toHaveBeenCalled();
  trashActions.busy = false;
  view.rerender(wrap());
  fireEvent.contextMenu(generated);
  expect(screen.getByRole("menuitem", { name: "删除所选 2 项" })).toBeVisible();
  trashActions.busy = true;
  view.rerender(wrap());
  expect(screen.getByRole("menuitem", { name: "删除所选 2 项" })).toBeDisabled();
});

it("treats macOS Ctrl-primary contextmenu as selection and real Ctrl-secondary as a menu", async () => {
  directoryWithDocuments();
  const generated = await screen.findByRole("button", { name: "generated" });
  fireEvent.mouseDown(generated, { button: 0, ctrlKey: true });
  fireEvent.contextMenu(generated, { button: 2, ctrlKey: true });
  fireEvent.click(generated, { ctrlKey: true });
  expect(generated).toHaveAttribute("aria-expanded", "false");
  expect(generated).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(generated);
  const leaf = await screen.findByRole("button", { name: "result.txt" });
  fireEvent.mouseDown(leaf, { button: 0, ctrlKey: true });
  fireEvent.contextMenu(leaf, { button: 2, ctrlKey: true });
  fireEvent.click(leaf, { ctrlKey: true });
  expect(leaf).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("menuitem")).toBeNull();
  expect(useProjectFileNavigation.getState().request).toBeNull();
  fireEvent.mouseDown(generated, { button: 2, ctrlKey: true });
  fireEvent.contextMenu(generated, { button: 2, ctrlKey: true });
  expect(screen.getByRole("menuitem", { name: "删除所选 2 项" })).toBeVisible();
});

it("clears selection and an open bulk menu when the Workspace binding changes at the same path", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (generation: string) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} rootPath="/project" binding={{ workspaceId: "w", generation }} /></QueryClientProvider>;
  const view = render(wrap("first"));
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.click(await screen.findByRole("button", { name: "result.txt" }), { ctrlKey: true });
  fireEvent.contextMenu(screen.getByRole("button", { name: "generated" }));
  expect(screen.getByRole("menuitem", { name: "删除所选 2 项" })).toBeVisible();
  view.rerender(wrap("reopened"));
  expect(screen.queryByRole("menuitem")).toBeNull();
  expect(await screen.findByRole("button", { name: "generated" })).toHaveAttribute("aria-pressed", "false");
});

it.each(["collapse", "external deletion", "toggle"])("retires a captured bulk menu after %s changes the visible selection", async change => {
  const view = directoryWithDocuments();
  const generated = await screen.findByRole("button", { name: "generated" });
  fireEvent.click(generated);
  const leaf = await screen.findByRole("button", { name: "result.txt" });
  fireEvent.click(leaf, { ctrlKey: true });
  fireEvent.contextMenu(generated);
  expect(screen.getByRole("menuitem", { name: "删除所选 2 项" })).toBeVisible();
  if (change === "collapse") fireEvent.click(generated);
  else if (change === "toggle") fireEvent.click(leaf, { metaKey: true });
  else {
    vi.mocked(projectDirectoryApi.list).mockResolvedValue([]);
    await act(async () => { await view.client.invalidateQueries({ queryKey: ["project-directory", "/project", 7, "generated"] }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "result.txt" })).toBeNull());
  }
  await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  expect(trashActions.run).not.toHaveBeenCalled();
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

it.each([7, null])("opens a registered tree File menu with mouse and keyboard (owner=%s)", async projectId => {
  const client = new QueryClient();
  const document = { id: 1, managedPath: "/project/generated/result.txt" } as import("../layout/ProjectSidebar").ProjectSidebarDocumentItem;
  const openContextMenu = vi.fn();
  render(<QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={projectId} rootPath="/project" documents={[document]} fileMenu={{ openContextMenu, renderRenameInput: () => null }} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  const row = await screen.findByRole("button", { name: "result.txt" });
  fireEvent.contextMenu(row, { clientX: 60, clientY: 70 });
  expect(openContextMenu).toHaveBeenCalledWith(document, 60, 70);
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  expect(openContextMenu).toHaveBeenCalledTimes(2);
  expect(fileActions.register).not.toHaveBeenCalled();
  expect(useProjectFileNavigation.getState().request).toBeNull();
});

it("does not open an old unregistered File menu after Workspace changes at the same root", async () => {
  const client = new QueryClient();
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "g" });
  const registering = deferred<{ state: string; object: { id: string } }>();
  fileActions.register.mockReturnValue(registering.promise);
  const openContextMenu = vi.fn();
  const wrap = (workspaceRoot: string) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={null} rootPath="/project" workspaceRoot={workspaceRoot} fileMenu={{ openContextMenu, renderRenameInput: () => null }} /></QueryClientProvider>;
  const view = render(wrap("/workspace-a"));
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.contextMenu(await screen.findByRole("button", { name: "result.txt" }));
  await waitFor(() => expect(fileActions.register).toHaveBeenCalledWith({ workspaceId: "w", generation: "g" }, null, "generated/result.txt"));
  view.rerender(wrap("/workspace-b"));
  await act(async () => registering.resolve({ state: "ready", object: { id: "1" } }));
  expect(openContextMenu).not.toHaveBeenCalled();
  expect(fileActions.workspacePage).not.toHaveBeenCalled();
});

it("manually refreshes a stale expanded tree and preserves the current File navigation", async () => {
  panel();
  tree();
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.click(await screen.findByRole("button", { name: "result.txt" }));
  const request = useProjectFileNavigation.getState().request;
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: "刷新文件列表" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "generated" })).toBeNull());
  expect(useProjectFileNavigation.getState().request).toEqual(request);
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新文件列表" })).toBeEnabled());
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
  directoryWithDocuments();
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

it("expands only ancestors of the focused path and follows focus without optimistic selection", async () => {
  const sibling = { ...file, name: "other.txt", relativePath: "generated/other.txt" };
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, relative) => relative === "generated" ? [file, sibling] : [folder]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const component = (path: string | null) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} rootPath="/project" activeRelativePath={path} /></QueryClientProvider>;
  const view = render(component(file.relativePath));
  const selected = await screen.findByRole("button", { name: "result.txt" });
  const other = screen.getByRole("button", { name: "other.txt" });
  expect(selected).toHaveClass("is-active");
  expect(screen.getByRole("button", { name: "generated" })).toHaveAttribute("aria-expanded", "true");
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("交付", { exact: true })).toBeNull();
  fireEvent.click(other);
  expect(selected).toHaveClass("is-active");
  expect(other).not.toHaveClass("is-active");
  view.rerender(component(sibling.relativePath));
  expect(selected).not.toHaveClass("is-active");
  expect(other).toHaveClass("is-active");
  view.rerender(component(null));
  expect(other).not.toHaveClass("is-active");
});

it("does not poll expanded directories while idle", async () => {
  vi.useFakeTimers();
  try {
    panel(); tree();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    fireEvent.click(screen.getByRole("button", {name:"generated"}));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const reads = vi.mocked(projectDirectoryApi.list).mock.calls.length;
    expect(reads).toBeGreaterThanOrEqual(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(reads);
  } finally { vi.useRealTimers(); }
});

it("does not expand ordinary owner-page invalidation or navigation revisions into tree reads", async () => {
  const view = panel(); tree();
  fireEvent.click(await screen.findByRole("button", {name:"generated"}));
  await screen.findByRole("button", {name:"result.txt"});
  await act(async () => {});
  const reads = vi.mocked(projectDirectoryApi.list).mock.calls.length;
  view.client.setQueryData(["project-page", 7], {});
  await act(async () => { await view.client.invalidateQueries({queryKey:["project-page",7]}); });
  act(() => useProjectFileNavigation.getState().refresh(7));
  await act(async () => {});
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(reads);
});

it("refreshes only dirty branches among fifty expanded siblings, with precise hidden deferral", async () => {
  Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});
  const binding={workspaceId:"w",generation:"g"};native.binding.mockResolvedValue(binding);
  let dirty!: (hint:{binding:typeof binding;projectId:number|null;relativePaths?:string[]})=>void;
  native.listen.mockImplementation(async (_name,callback)=>{dirty=callback;return vi.fn();});
  const folders=Array.from({length:50},(_,i)=>({...folder,name:`branch-${i}`,relativePath:`branch-${i}`}));
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id,path)=>path===""?folders:[]);
  const visibility=vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const view=render(<QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} workspaceRoot="/workspace" rootPath="/project"/></QueryClientProvider>);
  try {
    await screen.findByRole("button",{name:"branch-49"});
    for(const entry of folders)fireEvent.click(screen.getByRole("button",{name:entry.name}));
    await waitFor(()=>expect(projectDirectoryApi.list).toHaveBeenCalledTimes(51));
    await act(async()=>{});vi.mocked(projectDirectoryApi.list).mockClear();
    await act(async()=>{dirty({binding,projectId:7,relativePaths:["branch-3"]});dirty({binding,projectId:7,relativePaths:["branch-3"]});});
    expect(projectDirectoryApi.list).toHaveBeenCalledExactlyOnceWith(7,"branch-3");
    visibility.mockReturnValue("hidden");act(()=>document.dispatchEvent(new Event("visibilitychange")));
    await act(async()=>{dirty({binding,projectId:7,relativePaths:["branch-5"]});});
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");act(()=>document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(()=>expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
    expect(projectDirectoryApi.list).toHaveBeenLastCalledWith(7,"branch-5");
    await act(async()=>{dirty({binding,projectId:7,relativePaths:[]});});
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
  } finally {view.unmount();visibility.mockRestore();}
});

it("derives import, move and rename directory changes from committed File paths without save fanout", async () => {
  const folders=["a","b","other"].map(name=>({...folder,name,relativePath:name}));
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id,path)=>path===""?folders:[]);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const item={id:1,managedPath:"/project/a/old.txt"} as import("../layout/ProjectSidebar").ProjectSidebarDocumentItem;
  const wrap=(documents:typeof item[]) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} rootPath="/project" documents={documents}/></QueryClientProvider>;
  const view=render(wrap([item]));await screen.findByRole("button",{name:"other"});
  for(const entry of folders)fireEvent.click(screen.getByRole("button",{name:entry.name}));
  await waitFor(()=>expect(projectDirectoryApi.list).toHaveBeenCalledTimes(4));
  vi.mocked(projectDirectoryApi.list).mockClear();
  view.rerender(wrap([{...item,title:"saved"}]));await act(async()=>{});
  expect(projectDirectoryApi.list).not.toHaveBeenCalled();
  const moved={...item,managedPath:"/project/b/new.txt"};view.rerender(wrap([moved]));
  await waitFor(()=>expect(projectDirectoryApi.list).toHaveBeenCalledTimes(3));
  expect(projectDirectoryApi.list.mock.calls.map(call=>call[1]).sort()).toEqual(["","a","b"]);
  vi.mocked(projectDirectoryApi.list).mockClear();
  view.rerender(wrap([moved,{...item,id:2,managedPath:"/project/b/imported.txt"}]));
  await waitFor(()=>expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
  expect(projectDirectoryApi.list.mock.calls.map(call=>call[1]).sort()).toEqual(["","b"]);
  vi.mocked(projectDirectoryApi.list).mockClear();
  view.rerender(wrap([{...moved,managedPath:"/project/b/renamed.txt"}]));
  await waitFor(()=>expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
  expect(projectDirectoryApi.list.mock.calls.map(call=>call[1]).sort()).toEqual(["","b"]);
});

it("keeps usable A-B-A snapshots and discovers changes made while unmounted on use", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (id: number) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={id} workspaceRoot="/workspace" rootPath={`/project-${id}`} /></QueryClientProvider>;
  const view = render(wrap(7));
  await screen.findByRole("button", { name: "generated" });
  view.rerender(wrap(8));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
  expect(client.getQueryData(["project-directory", "/project-7", 7, "", 0, "/workspace"])).toEqual([folder]);
  const changed = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(changed.promise);
  view.rerender(wrap(7));
  // The old listing stays visible for the entire native cache reconciliation.
  expect(screen.getByRole("button", { name: "generated" })).toBeVisible();
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(3));
  await act(async () => changed.resolve([folder, { ...file, name: "new.txt", relativePath: "new.txt" }]));
  expect(await screen.findByRole("button", { name: "new.txt" })).toBeVisible();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(3);
});

it("reconciles A-B-A even when A's pre-unmount native read is still pending", async () => {
  const old = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (id: number) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={id} rootPath={`/project-${id}`} /></QueryClientProvider>;
  const view = render(wrap(7));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1));
  view.rerender(wrap(8));
  await screen.findByRole("button", { name: "generated" });
  view.rerender(wrap(7));
  await act(async () => {});
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([{ ...file, name: "changed-while-away.txt", relativePath: "changed-while-away.txt" }]);
  await act(async () => old.resolve([folder]));
  expect(await screen.findByRole("button", { name: "changed-while-away.txt" })).toBeVisible();
  expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""], [8, ""], [7, ""]]);
});

it("preserves a cached listing when revalidation fails and retries on demand", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const browser = () => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} rootPath="/project" /></QueryClientProvider>;
  const first = render(browser());
  await screen.findByRole("button", { name: "generated" });
  first.unmount();
  vi.mocked(projectDirectoryApi.list).mockRejectedValueOnce(new Error("暂时离线"));
  render(browser());
  expect(screen.getByRole("button", { name: "generated" })).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时离线");
  expect(screen.getByRole("button", { name: "generated" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重试读取目录" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("isolates cached listings by Workspace path even when Project id and root match", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (workspaceRoot: string) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} workspaceRoot={workspaceRoot} rootPath="/project" /></QueryClientProvider>;
  const view = render(wrap("/workspace-a"));
  await screen.findByRole("button", { name: "generated" });
  const next = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(next.promise);
  view.rerender(wrap("/workspace-b"));
  expect(screen.queryByRole("button", { name: "generated" })).toBeNull();
  await act(async () => next.resolve([]));
  expect(await screen.findByText("此目录为空")).toBeVisible();
});

it("isolates native cache snapshots by Workspace identity and open generation at the same path", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.listen.mockResolvedValue(vi.fn());
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "first" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = () => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} workspaceRoot="/workspace" rootPath="/project" /></QueryClientProvider>;
  const first = render(panel());
  await screen.findByRole("button", { name: "generated" });
  first.unmount();
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "second" });
  const next = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(next.promise);
  render(panel());
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "generated" })).toBeNull();
  await act(async () => next.resolve([]));
  expect(await screen.findByText("此目录为空")).toBeVisible();
});

it("coalesces native directory dirty hints, isolates binding/scope and defers reads while hidden", async () => {
  Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});
  const binding={workspaceId:"w",generation:"g"};
  native.binding.mockResolvedValue(binding);
  let dirty!: (hint:{binding:typeof binding;projectId:number|null})=>void;
  const unlisten=vi.fn();
  native.listen.mockImplementation(async (_name,callback)=>{dirty=callback;return unlisten;});
  const visibility=vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const view=render(<QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} workspaceRoot="/workspace" rootPath="/project"/></QueryClientProvider>);
  try {
    await screen.findByRole("button",{name:"generated"});
    await waitFor(()=>expect(native.listen).toHaveBeenCalledWith("mind:project-directory-dirty",expect.any(Function)));
    await act(async()=>{});
    act(()=>{dirty({binding,projectId:8});dirty({binding:{...binding,generation:"old"},projectId:7});dirty({binding:{...binding,workspaceId:"other"},projectId:7});});
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
    vi.mocked(projectDirectoryApi.list).mockResolvedValue([folder,{...folder,name:"empty",relativePath:"empty"}]);
    await act(async()=>{dirty({binding,projectId:7});dirty({binding,projectId:7});});
    await screen.findByRole("button",{name:"empty"});
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");act(()=>document.dispatchEvent(new Event("visibilitychange")));
    await act(async()=>{dirty({binding,projectId:7});dirty({binding,projectId:7});});
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
    vi.mocked(projectDirectoryApi.list).mockResolvedValue([folder]);
    visibility.mockReturnValue("visible");act(()=>document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(()=>expect(screen.queryByRole("button",{name:"empty"})).toBeNull());
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(3);
  } finally { view.unmount();visibility.mockRestore(); }
  expect(unlisten).toHaveBeenCalledOnce();
});

it('does not read a retained hidden navigation panel, and reconciles only when shown',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const wrap=(hidden:boolean)=><div hidden={hidden}><QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} rootPath="/project"/></QueryClientProvider></div>;
 const view=render(wrap(true));await act(async()=>{});expect(projectDirectoryApi.list).not.toHaveBeenCalled();
 view.rerender(wrap(false));await screen.findByRole('button',{name:'generated'});expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
 view.rerender(wrap(true));await act(async()=>{});
 await act(async()=>{await client.invalidateQueries({queryKey:['project-directory','/project',7]});});expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
 view.rerender(wrap(false));await waitFor(()=>expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
});

it("does not read into a cached binding after the native generation changes before enumeration", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.listen.mockResolvedValue(vi.fn());
  native.binding.mockResolvedValueOnce({ workspaceId: "w", generation: "before" })
    .mockResolvedValue({ workspaceId: "w", generation: "after" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} workspaceRoot="/workspace" rootPath="/project" /></QueryClientProvider>);
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(projectDirectoryApi.list).not.toHaveBeenCalled();
});

it("rejects a directory reply from another binding without caching its entries", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.listen.mockResolvedValue(vi.fn());
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "before" });
  const pending = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(pending.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} workspaceRoot="/workspace" rootPath="/project" /></QueryClientProvider>);
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledOnce());
  native.binding.mockResolvedValue({ workspaceId: "other", generation: "after" });
  await act(async () => pending.resolve([file]));
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(screen.queryByRole("button", { name: "result.txt" })).toBeNull();
  expect(client.getQueryData(["project-directory", "/project", 7, "", 0, "/workspace", "w", "before"])).toBeUndefined();
});

it("waits for the new scope's binding before starting its directory query", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.listen.mockResolvedValue(vi.fn());
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "g" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (projectId: number) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={projectId} workspaceRoot="/workspace" rootPath="/project" /></QueryClientProvider>;
  const view = render(wrap(7));
  await screen.findByRole("button", { name: "generated" });
  const pending = deferred<{ workspaceId: string; generation: string }>();
  native.binding.mockReturnValueOnce(pending.promise);
  view.rerender(wrap(8));
  await act(async () => {});
  expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""]]);
  await act(async () => pending.resolve({ workspaceId: "w", generation: "g" }));
  await waitFor(() => expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""], [8, ""]]));
});

it("keeps the expanded tree on the shared distance-driven scroll mask through content and size changes", async () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;
  const measures: ResizeObserverCallback[] = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { measures.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  };
  try {
    directoryWithDocuments();
    await screen.findByRole("button", { name: "generated" });
    const viewport = screen.getByRole("region", { name: "项目目录内容" });
    const frame = viewport.parentElement!;
    let scrollHeight = 300;
    Object.defineProperty(viewport, "scrollHeight", { get: () => scrollHeight, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 100, configurable: true });
    const position = (top: number) => { viewport.scrollTop = top; fireEvent.scroll(viewport); };
    position(0);
    expect(frame.style.getPropertyValue("--scroll-fade-top-opacity")).toBe("0");
    expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("1");
    position(168);
    expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
    position(200);
    expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0");
    position(184);
    expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.25");
    fireEvent.click(screen.getByRole("button", { name: "generated" }));
    await screen.findByRole("button", { name: "result.txt" });
    scrollHeight = 100;
    act(() => { for (const measure of measures) measure([], {} as ResizeObserver); });
    expect(frame.style.getPropertyValue("--scroll-fade-top-opacity")).toBe("0");
    expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0");
  } finally { globalThis.ResizeObserver = OriginalResizeObserver; }
});

it("refreshes a reopened same-path binding, synchronizes flat/tree and retains the open editor draft", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.listen.mockResolvedValue(vi.fn());
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "first" });
  const documents = [{ id: 1, managedPath: "/project/gone.txt", health: "normal" }] as import("../layout/ProjectSidebar").ProjectSidebarDocumentItem[];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useProjectFileNavigation.getState().open({ projectId: 7, workspaceRoot: "/workspace", path: "gone.txt" });
  const request = useProjectFileNavigation.getState().request;
  render(<QueryClientProvider client={client}>
    <input aria-label="existing editor" defaultValue="saved" />
    <HomeProjectFiles fileScope={{ projectId: 7, rootPath: "/project", workspaceRoot: "/workspace", name: "Project" }} documents={documents} />
  </QueryClientProvider>);
  const editor = screen.getByRole("textbox", { name: "existing editor" });
  fireEvent.change(editor, { target: { value: "unsaved draft" } });
  tree();
  await screen.findByRole("button", { name: "generated" });
  fireEvent.click(screen.getByRole("button", { name: "刷新文件列表" }));
  await waitFor(() => expect(screen.getByTestId("visible-file-ids")).toHaveTextContent(/^$/));
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新文件列表" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "existing editor" })).toBe(editor);
  expect(editor).toHaveValue("unsaved draft");
  expect(useProjectFileNavigation.getState().request).toBe(request);

  native.binding.mockResolvedValue({ workspaceId: "w", generation: "reopened" });
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([{ name: "gone.txt", relativePath: "gone.txt", kind: "file", bytes: 1 }]);
  fireEvent.click(screen.getByRole("button", { name: "刷新文件列表" }));
  expect(await screen.findByRole("button", { name: "gone.txt" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新文件列表" })).toBeEnabled());
  expect(screen.getByTestId("visible-file-ids")).toHaveTextContent("1");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "平铺展示" }));
  expect(screen.getByTestId("visible-file-ids")).toHaveTextContent("1");
  expect(screen.getByRole("textbox", { name: "existing editor" })).toBe(editor);
  expect(editor).toHaveValue("unsaved draft");
  expect(useProjectFileNavigation.getState().request).toBe(request);
});

it("refuses a managed file menu selected from an old binding's cached tree", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.listen.mockResolvedValue(vi.fn());
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "before" });
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([file]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const menu = { openContextMenu: vi.fn(), renderRenameInput: () => null };
  const documents = [{ id: 1, managedPath: "/project/generated/result.txt" }] as import("../layout/ProjectSidebar").ProjectSidebarDocumentItem[];
  render(<QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={7} workspaceRoot="/workspace" rootPath="/project" fileMenu={menu} documents={documents} /></QueryClientProvider>);
  const row = await screen.findByRole("button", { name: "result.txt" });
  native.binding.mockResolvedValue({ workspaceId: "w", generation: "reopened" });
  fireEvent.contextMenu(row);
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(menu.openContextMenu).not.toHaveBeenCalled();
  expect(fileActions.register).not.toHaveBeenCalled();
});

it.each(["scoped", "all"])("orders %s native dirty reads before a deleted expanded subtree and can discover its restoration", async mode => {
  const nested = { ...folder, name: "deep", relativePath: "generated/deep" };
  const leaf = { ...file, relativePath: "generated/deep/result.txt" };
  const removedRoot = deferred<ProjectDirectoryEntry[]>();
  let removed = false;
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_owner, path) => {
    if (path === "") return removed ? removedRoot.promise : [folder];
    if (removed) throw new Error(`ENOENT: ${path}`);
    return path === "generated" ? [nested] : [leaf];
  });
  const view = watchedDirectory();
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.click(await screen.findByRole("button", { name: "deep" }));
  await screen.findByRole("button", { name: "result.txt" });
  vi.mocked(projectDirectoryApi.list).mockClear();
  removed = true;
  act(() => view.listeners[0]({ binding: { workspaceId: "w", generation: "g" }, projectId: 7,
    relativePaths: mode === "all" ? null : ["", "generated", "generated/deep"] }));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledWith(7, ""));
  // The parent remains pending while its stale child observers are mounted.
  // Concurrent invalidation would already have read both vanished paths here.
  expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""]]);
  await act(async () => removedRoot.resolve([]));
  await waitFor(() => expect(screen.queryByRole("button", { name: "generated" })).toBeNull());
  expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""]]);
  expect(screen.queryByRole("alert")).toBeNull();

  removed = false;
  act(() => view.dirty());
  await screen.findByRole("button", { name: "generated" });
  fireEvent.click(await screen.findByRole("button", { name: "deep" }));
  expect(await screen.findByRole("button", { name: "result.txt" })).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["EACCES: generated", "ENOENT after a successful parent read"])("reports %s from a dirty directory still listed by its parent", async message => {
  const nested = { ...folder, name: "deep", relativePath: "generated/deep" };
  const leaf = { ...file, relativePath: "generated/deep/result.txt" };
  const parent = deferred<ProjectDirectoryEntry[]>();
  let changed = false;
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_owner, path) => {
    if (path === "") return changed ? parent.promise : [folder];
    if (changed) throw new Error(message);
    return path === "generated" ? [nested] : [leaf];
  });
  const view = watchedDirectory();
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.click(await screen.findByRole("button", { name: "deep" }));
  await screen.findByRole("button", { name: "result.txt" });
  vi.mocked(projectDirectoryApi.list).mockClear();
  changed = true;
  act(() => view.listeners[0]({ binding: { workspaceId: "w", generation: "g" }, projectId: 7,
    relativePaths: ["", "generated", "generated/deep"] }));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledWith(7, ""));
  expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""]]);
  await act(async () => parent.resolve([folder]));
  await waitFor(() => expect(screen.getAllByRole("alert").some(node => node.textContent?.includes(message))).toBe(true));
  expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""], [7, "generated"]]);
  expect(screen.getByRole("button", { name: "result.txt" })).toBeVisible();
});

it("defers parent and child dirty hints while hidden, then confirms deletion before reading children", async () => {
  let removed = false;
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_owner, path) => {
    if (path === "") return removed ? [] : [folder];
    if (removed) throw new Error(`ENOENT: ${path}`);
    return [file];
  });
  const view = watchedDirectory();
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  await screen.findByRole("button", { name: "result.txt" });
  view.rerender(view.wrap(7, true));
  await act(async () => {});
  vi.mocked(projectDirectoryApi.list).mockClear();
  removed = true;
  await act(async () => view.listeners[0]({ binding: { workspaceId: "w", generation: "g" }, projectId: 7,
    relativePaths: ["", "generated"] }));
  expect(projectDirectoryApi.list).not.toHaveBeenCalled();
  view.rerender(view.wrap());
  await waitFor(() => expect(screen.queryByRole("button", { name: "generated" })).toBeNull());
  expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""]]);
  expect(screen.queryByRole("alert")).toBeNull();
});
