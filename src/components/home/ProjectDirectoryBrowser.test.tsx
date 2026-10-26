import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectFileMenuControls } from "../layout/ProjectSidebar";
import type { ReactNode } from "react";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { ProjectDirectoryBrowser } from "./ProjectDirectoryBrowser";
import { HomeProjectFiles } from "./HomeProjectFiles";
import { projectDirectoryApi, type ProjectDirectoryEntry } from "../../services/projectDirectoryApi";

const native = vi.hoisted(() => ({binding:vi.fn(),listen:vi.fn()}));
vi.mock("../../services/recordDocumentApi", () => ({recordDocumentApi:{bindingGet:native.binding}}));
vi.mock("../../services/desktopApi", () => ({desktopApi:{listenEvent:native.listen}}));
afterEach(() => { Reflect.deleteProperty(window,"__TAURI_INTERNALS__"); });
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { list: vi.fn() } }));
vi.mock("../layout/ProjectSidebar", () => ({ ProjectSidebar: ({ fileHeaderActions, fileContent, fileFilter }: { fileHeaderActions?: ReactNode; fileContent?: ReactNode | ((controls: ProjectFileMenuControls) => ReactNode); fileFilter?: { query: string; tagId: number | null } }) => <div><div>{fileHeaderActions}</div>{(typeof fileContent === "function" ? fileContent({ openContextMenu: vi.fn(), renderRenameInput: () => null }) : fileContent) ?? <div>平铺文件：{fileFilter?.query}:{fileFilter?.tagId}</div>}</div> }));
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
  const listeners: ((hint: { binding: typeof binding; projectId: number; relativePaths: string[] }) => void)[] = [];
  native.listen.mockImplementation(async (_name, callback) => { listeners.push(callback); return vi.fn(); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (id = 7, hidden = false, documents: import("../layout/ProjectSidebar").ProjectSidebarDocumentItem[] = []) => <div hidden={hidden}><QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={id} workspaceRoot="/workspace" rootPath={`/project-${id}`} documents={documents} /></QueryClientProvider></div>;
  const view = render(wrap());
  return { ...view, wrap, listeners, dirty: () => listeners[0]({ binding, projectId: 7, relativePaths: [""] }) };
}

function directoryWithDocuments() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (documents: import("../layout/ProjectSidebar").ProjectSidebarDocumentItem[] = [], hidden = false, id = 7) =>
    <div hidden={hidden}><QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={id} rootPath="/project" documents={documents} /></QueryClientProvider></div>;
  const view = render(wrap());
  const imported = { id: 1, managedPath: "/project/imported.txt" } as import("../layout/ProjectSidebar").ProjectSidebarDocumentItem;
  return { ...view, client, wrap, imported };
}

it("merges native, documents and focus changes into one fresh read while an older read is pending", async () => {
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

it.each(["initial", "existing"])("reconciles a focus event overlapping an %s read", async mode => {
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
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([{ ...folder, name: "after-focus", relativePath: "after-focus" }]);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before);
  await act(async () => { old.resolve([folder]); });
  expect(await screen.findByRole("button", { name: "after-focus" })).toBeVisible();
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(before + 1);
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

it.each(["focus", "documents"].flatMap(source => ["unmount", "scope"].map(change => ({ source, change }))))("disposes $source refresh coordination on $change", async ({ source, change }) => {
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

it.each(["initial", "focus"].flatMap(mode => [false, true].map(burst => ({ mode, burst }))))("keeps dirty during $mode read (burst=$burst) until a fresh snapshot is read", async ({ mode, burst }) => {
  const old = deferred<ProjectDirectoryEntry[]>();
  const fresh = { ...folder, name: "fresh", relativePath: "fresh" };
  if (mode === "initial") vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = watchedDirectory();
  await waitFor(() => expect(view.listeners).toHaveLength(1));
  if (mode === "focus") {
    await screen.findByRole("button", { name: "generated" });
    vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
    act(() => window.dispatchEvent(new Event("focus")));
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

it.each(["initial", "focus"])("defers dirty received during %s I/O when hidden before it settles", async mode => {
  const old = deferred<ProjectDirectoryEntry[]>();
  if (mode === "initial") vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
  const view = watchedDirectory();
  await waitFor(() => expect(view.listeners).toHaveLength(1));
  if (mode === "focus") {
    await screen.findByRole("button", { name: "generated" });
    vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(old.promise);
    act(() => window.dispatchEvent(new Event("focus")));
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
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it("does not expand ordinary owner-page invalidation or navigation revisions into tree reads", async () => {
  const view = panel(); tree();
  fireEvent.click(await screen.findByRole("button", {name:"generated"}));
  await screen.findByRole("button", {name:"result.txt"});
  view.client.setQueryData(["project-page", 7], {});
  await act(async () => { await view.client.invalidateQueries({queryKey:["project-page",7]}); });
  act(() => useProjectFileNavigation.getState().refresh(7));
  await act(async () => {});
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
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

it("reconciles directory-only changes on focus without a timer", async () => {
  panel(); tree();
  await screen.findByRole("button", {name:"generated"});
  vi.mocked(projectDirectoryApi.list).mockResolvedValue([folder,{...folder,name:"empty",relativePath:"empty"}]);
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByRole("button", {name:"empty"});
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
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
