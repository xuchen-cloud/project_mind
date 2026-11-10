import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentObjectRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { ProjectDirectoryFile } from "../../lib/file-types";
import { projectDirectoryQueryKey } from "../../lib/project-directory-query";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { projectDirectoryApi, type DirectoryChangeTarget, type PreparedNavigationTrash, type ProjectDirectoryEntry } from "../../services/projectDirectoryApi";
import { useFeedbackStore } from "../../state/feedback-store";
import type { FileSelectionItem } from "./useFileSelection";
import { useNavigationTrash } from "./useNavigationTrash";

const native = vi.hoisted(() => ({
  binding: vi.fn(), prepare: vi.fn(), trash: vi.fn(), resolve: vi.fn(), confirm: vi.fn(),
  list: vi.fn(), command: vi.fn(), fileCommand: vi.fn(),
}));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: native.binding } }));
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: {
  prepareTrash: native.prepare, trash: native.trash, list: native.list,
} }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { resolve: native.resolve } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: {
  confirm: native.confirm, command: native.command, fileCommand: native.fileCommand,
} }));

const binding: AgentWorkspaceBinding = { workspaceId: "workspace", generation: "generation-1" };
type Options = Parameters<typeof useNavigationTrash>[0];
const scope: Options = { workspaceRoot: "/workspace", rootPath: "/root", projectId: 7, binding };
const otherScope: Options = { workspaceRoot: "/other-workspace", rootPath: "/other-root", projectId: 8,
  binding: { workspaceId: "other-workspace", generation: "generation-2" } };
const fixtures = new Map<string, FileSelectionItem>();

function item(relativePath: string, kind: FileSelectionItem["kind"] = "file", fileId?: number): FileSelectionItem {
  const value = { key: `${kind}:${relativePath}`, relativePath, kind, ...(fileId === undefined ? {} : { fileId }) };
  fixtures.set(relativePath, value);
  return value;
}
function plan(value: FileSelectionItem): PreparedNavigationTrash {
  return { relativePath: value.relativePath, kind: value.kind, token: `token:${value.relativePath}`,
    identityToken: `identity:${value.relativePath}`, files: value.fileId === undefined ? [] : [{ fileId: value.fileId, revision: 2 }] };
}
function prepared(target: DirectoryChangeTarget) {
  const value = fixtures.get(target.relativePath);
  if (!value) throw new Error(`Unexpected prepare: ${target.relativePath}`);
  return plan(value);
}
function resolved(object: AgentObjectRef): ProjectDirectoryFile {
  const value = [...fixtures.values()].find(value => value.fileId === Number(object.id));
  if (!value) throw new Error(`Unexpected FileID: ${object.id}`);
  return { object, relativePath: value.relativePath, name: value.relativePath.split("/").at(-1)!,
    versionNumber: 3, contentHash: "retained-hash", state: "ready", reason: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup(options: Options = scope) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(props => useNavigationTrash(props), { wrapper, initialProps: options });
  return { ...view, client };
}
type View = ReturnType<typeof setup>;
type Action = ReturnType<ReturnType<typeof useNavigationTrash>["capture"]>;
function start(view: View, selection: FileSelectionItem[]) {
  let pending!: ReturnType<Action>;
  act(() => { pending = view.result.current.capture(selection)(); });
  return pending;
}
async function run(view: View, selection: FileSelectionItem[]) {
  let outcome: Awaited<ReturnType<Action>> = undefined;
  await act(async () => { outcome = await view.result.current.capture(selection)(); });
  return outcome;
}
function observeRoot(view: View, initialData: ProjectDirectoryEntry[], options = scope) {
  const key = projectDirectoryQueryKey(options.rootPath, options.projectId, "", options.workspaceRoot, options.binding);
  const observer = new QueryObserver(view.client, { queryKey: key, initialData, staleTime: Infinity,
    queryFn: () => projectDirectoryApi.list(options.projectId, "") });
  const unsubscribe = observer.subscribe(() => {});
  return { key, unsubscribe };
}
function entry(value: FileSelectionItem): ProjectDirectoryEntry {
  return { name: value.relativePath, relativePath: value.relativePath, kind: value.kind, bytes: 0 };
}
const toasts = () => useFeedbackStore.getState().toasts;

beforeEach(() => {
  vi.resetAllMocks();
  fixtures.clear();
  useFeedbackStore.setState({ toasts: [] });
  useProjectFileNavigation.setState({ request: null, revisions: {} });
  native.binding.mockResolvedValue(binding);
  native.prepare.mockImplementation(async (target: DirectoryChangeTarget) => prepared(target));
  native.resolve.mockImplementation(async (_binding: AgentWorkspaceBinding, object: AgentObjectRef) => resolved(object));
  native.confirm.mockResolvedValue(true);
  native.trash.mockResolvedValue({ relativePath: null, fileIds: [] });
  native.list.mockResolvedValue([]);
});

it("finishes every initial prepare before one confirmation, then every reprepare before any commit", async () => {
  const first = item("folder", "directory"), second = item("note.md", "file", 41);
  const initial = deferred<PreparedNavigationTrash>(), recheck = deferred<PreparedNavigationTrash>();
  native.prepare.mockImplementation(async (target: DirectoryChangeTarget) => {
    const call = native.prepare.mock.calls.length;
    return call === 2 ? initial.promise : call === 4 ? recheck.promise : prepared(target);
  });
  const view = setup();
  const pending = start(view, [first, second]);
  await waitFor(() => expect(native.prepare).toHaveBeenCalledTimes(2));
  expect(view.result.current.busy).toBe(true);
  expect(native.confirm).not.toHaveBeenCalled();
  await act(async () => initial.resolve(plan(second)));
  await waitFor(() => expect(native.prepare).toHaveBeenCalledTimes(4));
  expect(native.confirm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("所选的 2 项"), "删除所选项目");
  expect(native.confirm.mock.calls[0][0]).toContain("包括尚未纳管的文件");
  expect(native.trash).not.toHaveBeenCalled();
  await act(async () => recheck.resolve(plan(second)));
  let outcome;
  await act(async () => { outcome = await pending; });
  expect(outcome).toEqual({ succeeded: [first, second], failed: [] });
  expect(native.resolve).toHaveBeenCalledTimes(2);
  expect(native.trash).toHaveBeenNthCalledWith(1, { binding, projectId: 7, relativePath: "folder",
    token: plan(first).token, confirmed: true, requestId: expect.any(String) });
  expect(native.trash.mock.calls[0][0].requestId).not.toBe(native.trash.mock.calls[1][0].requestId);
  expect(view.result.current.busy).toBe(false);
});

it("deduplicates selected descendants regardless of order while preserving folder-copy boundaries", async () => {
  const child = item("folder/deep/note.md", "file", 41), nested = item("folder/deep", "directory");
  const parent = item("folder", "directory"), sibling = item("folder-copy", "directory"), plain = item("folder.md");
  const view = setup();
  expect(await run(view, [child, nested, sibling, parent, parent, plain])).toEqual({ succeeded: [sibling, parent, plain], failed: [] });
  expect(native.prepare.mock.calls.map(([target]) => target.relativePath)).toEqual([
    "folder-copy", "folder", "folder.md", "folder-copy", "folder", "folder.md",
  ]);
  expect(native.confirm.mock.calls[0][0]).toContain("所选的 3 项");
  expect(native.resolve).not.toHaveBeenCalled();
});

it.each(["initial", "reprepare"])("rejects a same-path kind replacement during %s preflight", async phase => {
  const selected = item("folder", "directory");
  native.prepare.mockImplementation(async () => ({ ...plan(selected),
    kind: phase === "initial" || native.prepare.mock.calls.length === 2 ? "file" : "directory" }));
  const view = setup();
  expect(await run(view, [selected])).toBeUndefined();
  expect(native.confirm).toHaveBeenCalledTimes(phase === "initial" ? 0 : 1);
  expect(native.trash).not.toHaveBeenCalled();
  expect(toasts()[0]).toMatchObject({ tone: "error", detail: expect.stringContaining("类型或身份已变化") });
});

it.each([7, null])("resolves FileID against its requested actual owner before preparing (owner=%s)", async projectId => {
  const selected = item("managed.md", "file", 41);
  native.resolve.mockRejectedValue({ code: "ownership_mismatch", message: "文件实际归属不匹配" });
  const view = setup({ ...scope, projectId });
  await run(view, [selected]);
  expect(native.resolve).toHaveBeenCalledExactlyOnceWith(binding, { workspaceId: binding.workspaceId,
    scope: projectId === null ? { kind: "workspace" } : { kind: "project", projectId }, kind: "file", id: "41" });
  expect(native.prepare).not.toHaveBeenCalled();
  expect(native.confirm).not.toHaveBeenCalled();
  expect(native.trash).not.toHaveBeenCalled();
  expect(toasts()[0].detail).toBe("文件实际归属不匹配");
});

it.each(["missing", "ambiguous", "unavailable", "moved"] as const)("refuses a FileID whose resolved state/path is %s", async state => {
  const selected = item("managed.md", "file", 41);
  native.resolve.mockImplementation(async (_binding: AgentWorkspaceBinding, object: AgentObjectRef) => ({
    ...resolved(object), state: state === "moved" ? "ready" : state,
    relativePath: state === "moved" ? "elsewhere.md" : selected.relativePath,
  }));
  const view = setup();
  await run(view, [selected]);
  expect(native.prepare).not.toHaveBeenCalled();
  expect(native.confirm).not.toHaveBeenCalled();
  expect(native.trash).not.toHaveBeenCalled();
  expect(toasts()[0].detail).toContain("文件身份或位置已变化");
});

it("rejects a new FileID at the selected path even when resolve still returns the captured file", async () => {
  const selected = item("managed.md", "file", 41);
  native.prepare.mockResolvedValue({ ...plan(selected), files: [{ fileId: 99, revision: 2 }] });
  const view = setup();
  await run(view, [selected]);
  expect(native.resolve).toHaveBeenCalledOnce();
  expect(native.confirm).not.toHaveBeenCalled();
  expect(native.trash).not.toHaveBeenCalled();
  expect(toasts()[0].detail).toContain("类型或身份已变化");
});

it.each(["token", "identity", "members", "revision"])("aborts the whole batch if the last member's %s changes after confirmation", async change => {
  const first = item("first.md"), last = item("last.md", "file", 41);
  native.prepare.mockImplementation(async (target: DirectoryChangeTarget) => {
    const value = prepared(target);
    if (native.prepare.mock.calls.length !== 4) return value;
    return { ...value, ...(change === "token" ? { token: "metadata-changed" }
      : change === "identity" ? { identityToken: "replacement" }
      : change === "members" ? { files: [...value.files, { fileId: 99, revision: 1 }] }
      : { files: [{ fileId: 41, revision: 3 }] }) };
  });
  const view = setup();
  await run(view, [first, last]);
  expect(native.confirm).toHaveBeenCalledOnce();
  expect(native.prepare).toHaveBeenCalledTimes(4);
  expect(native.trash).not.toHaveBeenCalled();
  expect(toasts()[0]).toMatchObject({ tone: "error", detail: expect.stringContaining("last.md") });
});

it("refuses active sessions before confirmation and preserves the live editor", async () => {
  const first = item("first.md"), active = item("active-folder", "directory");
  const editor = { workspaceRoot: "/workspace", projectId: 7, path: "/root/active-folder/draft.md" };
  useProjectFileNavigation.setState({ request: editor });
  native.prepare.mockImplementation(async (target: DirectoryChangeTarget) => {
    if (target.relativePath === active.relativePath) throw { code: "active_editors", message: "请先关闭打开的文件（含独立窗口）" };
    return prepared(target);
  });
  const view = setup();
  await run(view, [first, active]);
  expect(native.confirm).not.toHaveBeenCalled();
  expect(native.trash).not.toHaveBeenCalled();
  expect(native.command).not.toHaveBeenCalled();
  expect(native.fileCommand).not.toHaveBeenCalled();
  expect(useProjectFileNavigation.getState().request).toBe(editor);
  expect(toasts()[0].detail).toContain("含独立窗口");
});

it("cancels the one batch confirmation without repreparing or committing any item", async () => {
  const selection = [item("first.md"), item("folder", "directory")];
  native.confirm.mockResolvedValue(false);
  const view = setup();
  expect(await run(view, selection)).toBeUndefined();
  expect(native.prepare).toHaveBeenCalledTimes(2);
  expect(native.confirm).toHaveBeenCalledOnce();
  expect(native.trash).not.toHaveBeenCalled();
  expect(toasts()).toEqual([]);
  expect(view.result.current.busy).toBe(false);
});

it("retains partial commit results and refreshes the tree and flat page after successful items", async () => {
  const first = item("first.md"), failed = item("keep.md"), last = item("folder", "directory");
  native.trash.mockResolvedValueOnce({ relativePath: null, fileIds: [] }).mockRejectedValueOnce(new Error("权限拒绝"));
  native.list.mockResolvedValue([entry(failed)]);
  const view = setup();
  const root = observeRoot(view, [first, failed, last].map(entry));
  const page = new QueryObserver(view.client, { queryKey: ["project-page", 7], initialData: "before",
    staleTime: Infinity, queryFn: async () => "after" });
  const unsubscribePage = page.subscribe(() => {});
  const historyKey = ["file-version", 41, 3];
  view.client.setQueryData(historyKey, "retained bytes");
  try {
    expect(await run(view, [first, failed, last])).toEqual({ succeeded: [first, last], failed: [{ item: failed, message: "权限拒绝" }] });
    expect(native.trash).toHaveBeenCalledTimes(3);
    expect(view.client.getQueryData(root.key)).toEqual([entry(failed)]);
    expect(view.client.getQueryData(["project-page", 7])).toBe("after");
    expect(view.client.getQueryData(historyKey)).toBe("retained bytes");
    expect(toasts()[0]).toMatchObject({ tone: "error", title: "已移入回收站 2 项，1 项未删除", detail: "keep.md：权限拒绝" });
  } finally { root.unsubscribe(); unsubscribePage(); }
});

it("keeps successful mutation results when a real post-commit query refresh fails", async () => {
  const selection = [item("first.md"), item("folder", "directory")];
  native.list.mockRejectedValue(new Error("EACCES 读取目录失败"));
  const view = setup();
  const root = observeRoot(view, selection.map(entry));
  try {
    expect(await run(view, selection)).toEqual({ succeeded: selection, failed: [] });
    expect(native.trash).toHaveBeenCalledTimes(2);
    expect(view.client.getQueryState(root.key)?.status).toBe("error");
    expect(toasts()[0]).toMatchObject({ tone: "error", title: "已移入系统回收站 2 项",
      detail: expect.stringContaining("操作已完成，刷新失败：EACCES 读取目录失败") });
  } finally { root.unsubscribe(); }
});

it("waits for pre-commit reads and then rereads flat/tree without reading the retired source", async () => {
  const selected = item("folder", "directory"), view = setup();
  const oldTree = deferred<ProjectDirectoryEntry[]>(), oldPage = deferred<string>();
  native.list.mockReturnValueOnce(oldTree.promise).mockResolvedValue([]);
  const root = observeRoot(view, [entry(selected)]);
  const sourceRead = vi.fn().mockRejectedValue(new Error("ENOENT retired folder"));
  const source = new QueryObserver(view.client, {
    queryKey: projectDirectoryQueryKey(scope.rootPath, scope.projectId, "folder", scope.workspaceRoot, binding),
    initialData: [], staleTime: Infinity, queryFn: sourceRead,
  });
  const unsubscribeSource = source.subscribe(() => {});
  const pageRead = vi.fn().mockReturnValueOnce(oldPage.promise).mockResolvedValue("after");
  const page = new QueryObserver(view.client, { queryKey: ["project-page", 7], initialData: "before",
    staleTime: Infinity, queryFn: pageRead });
  const unsubscribePage = page.subscribe(() => {});
  try {
    act(() => {
      void view.client.refetchQueries({ queryKey: root.key, exact: true });
      void view.client.refetchQueries({ queryKey: ["project-page", 7] });
    });
    const pending = start(view, [selected]);
    await waitFor(() => expect(native.trash).toHaveBeenCalledOnce());
    expect(view.result.current.busy).toBe(true);
    expect(toasts()).toEqual([]);
    await act(async () => {
      oldTree.resolve([entry(selected)]); oldPage.resolve("stale page");
      expect(await pending).toEqual({ succeeded: [selected], failed: [] });
    });
    expect(native.list).toHaveBeenCalledTimes(2);
    expect(pageRead).toHaveBeenCalledTimes(2);
    expect(view.client.getQueryData(root.key)).toEqual([]);
    expect(view.client.getQueryData(["project-page", 7])).toBe("after");
    expect(sourceRead).not.toHaveBeenCalled();
    expect(toasts()[0].tone).toBe("success");
  } finally { root.unsubscribe(); unsubscribeSource(); unsubscribePage(); }
});

it("uses the menu-captured binding and reports its refusal rather than rebinding at click time", async () => {
  const selected = item("note.md");
  const view = setup();
  const action = view.result.current.capture([selected]);
  await act(async () => {});
  native.binding.mockResolvedValue({ ...binding, generation: "generation-2" });
  native.prepare.mockRejectedValue({ code: "workspace_changed", message: "菜单所属工作区已关闭" });
  await act(async () => { await action(); });
  expect(native.binding).toHaveBeenCalledExactlyOnceWith("/workspace");
  expect(native.prepare).toHaveBeenCalledExactlyOnceWith({ binding, projectId: 7, relativePath: "note.md" });
  expect(native.trash).not.toHaveBeenCalled();
  expect(toasts()[0].detail).toBe("菜单所属工作区已关闭");
});

it("rejects a binding that already differs when the menu is captured", async () => {
  native.binding.mockResolvedValue({ ...binding, generation: "new-generation" });
  const view = setup();
  await run(view, [item("note.md")]);
  expect(native.prepare).not.toHaveBeenCalled();
  expect(native.confirm).not.toHaveBeenCalled();
  expect(toasts()[0].detail).toContain("工作区已切换");
});

it("retires a captured menu when the same path reopens with a different binding", async () => {
  const view = setup();
  const action = view.result.current.capture([item("note.md")]);
  view.rerender({ ...scope, binding: { ...binding, generation: "new-generation" } });
  await act(async () => { expect(await action()).toBeUndefined(); });
  expect(native.prepare).not.toHaveBeenCalled();
  expect(native.confirm).not.toHaveBeenCalled();
  expect(native.trash).not.toHaveBeenCalled();
  expect(toasts()).toEqual([]);
});

it("limits refresh to the captured generation when no optional binding prop is supplied", async () => {
  const view = setup({ ...scope, binding: undefined });
  const foreignKey = projectDirectoryQueryKey(scope.rootPath, scope.projectId, "", scope.workspaceRoot,
    { ...binding, generation: "foreign-generation" });
  const ownKey = projectDirectoryQueryKey(scope.rootPath, scope.projectId, "", scope.workspaceRoot, binding);
  view.client.setQueryData(foreignKey, ["foreign data"]);
  view.client.setQueryData(ownKey, ["own data"]);
  expect(await run(view, [item("note.md")])).toMatchObject({ failed: [] });
  expect(view.client.getQueryState(ownKey)?.isInvalidated).toBe(true);
  expect(view.client.getQueryState(foreignKey)?.isInvalidated).toBe(false);
  expect(view.client.getQueryData(foreignKey)).toEqual(["foreign data"]);
});

it.each(["binding", "resolve", "prepare", "reprepare", "confirm", "commit"] as const)(
  "stops commands and feedback when scope switches during pending %s", async phase => {
    const managed = item("managed.md", "file", 41), next = item("next.md");
    const gate = deferred<unknown>();
    if (phase === "binding") native.binding.mockReturnValueOnce(gate.promise);
    if (phase === "resolve") native.resolve.mockReturnValueOnce(gate.promise);
    if (phase === "prepare") native.prepare.mockReturnValueOnce(gate.promise);
    if (phase === "reprepare") native.prepare.mockImplementation(async (target: DirectoryChangeTarget) =>
      native.prepare.mock.calls.length === 3 ? gate.promise : prepared(target));
    if (phase === "confirm") native.confirm.mockReturnValueOnce(gate.promise);
    if (phase === "commit") native.trash.mockReturnValueOnce(gate.promise);
    const view = setup();
    const pending = start(view, [managed, next]);
    const boundary = phase === "binding" ? native.binding : phase === "resolve" ? native.resolve
      : phase === "confirm" ? native.confirm : phase === "commit" ? native.trash : native.prepare;
    await waitFor(() => expect(boundary).toHaveBeenCalledTimes(phase === "reprepare" ? 3 : 1));
    const counts = [native.binding, native.resolve, native.prepare, native.confirm, native.trash].map(mock => mock.mock.calls.length);
    view.rerender(otherScope);
    const newKey = projectDirectoryQueryKey(otherScope.rootPath, otherScope.projectId, "", otherScope.workspaceRoot, otherScope.binding);
    view.client.setQueryData(newKey, ["new scope data"]);
    await act(async () => {
      gate.resolve(phase === "binding" ? binding : phase === "resolve" ? resolved({ workspaceId: binding.workspaceId,
        scope: { kind: "project", projectId: 7 }, kind: "file", id: "41" })
        : phase === "confirm" ? true : phase === "commit" ? { relativePath: null, fileIds: [41] } : plan(managed));
      expect(await pending).toBeUndefined();
    });
    expect([native.binding, native.resolve, native.prepare, native.confirm, native.trash].map(mock => mock.mock.calls.length)).toEqual(counts);
    expect(view.client.getQueryData(newKey)).toEqual(["new scope data"]);
    expect(view.client.getQueryState(newKey)?.isInvalidated).toBe(false);
    expect(toasts()).toEqual([]);
    expect(view.result.current.busy).toBe(false);
  },
);

it.each([false, true])("does not publish stale refresh completion into a new scope (reject=%s)", async reject => {
  const gate = deferred<ProjectDirectoryEntry[]>();
  native.list.mockReturnValueOnce(gate.promise);
  const selected = item("note.md"), view = setup();
  const root = observeRoot(view, [entry(selected)]);
  try {
    const pending = start(view, [selected]);
    await waitFor(() => expect(native.list).toHaveBeenCalledOnce());
    view.rerender(otherScope);
    const newKey = projectDirectoryQueryKey(otherScope.rootPath, otherScope.projectId, "", otherScope.workspaceRoot, otherScope.binding);
    view.client.setQueryData(newKey, ["new tree"]);
    await act(async () => {
      if (reject) gate.reject(new Error("old scope read failed")); else gate.resolve([]);
      expect(await pending).toBeUndefined();
    });
    expect(view.client.getQueryData(newKey)).toEqual(["new tree"]);
    expect(view.client.getQueryState(newKey)?.isInvalidated).toBe(false);
    expect(toasts()).toEqual([]);
  } finally { root.unsubscribe(); }
});

it("does not let an old commit completion clear the new scope's busy state or continue the old batch", async () => {
  const oldFirst = item("old-first.md"), oldNext = item("old-next.md"), fresh = item("fresh.md");
  const oldCommit = deferred<unknown>(), newCommit = deferred<unknown>();
  native.trash.mockReturnValueOnce(oldCommit.promise).mockReturnValueOnce(newCommit.promise);
  const view = setup();
  const oldPending = start(view, [oldFirst, oldNext]);
  await waitFor(() => expect(native.trash).toHaveBeenCalledOnce());
  view.rerender(otherScope);
  native.binding.mockResolvedValue(otherScope.binding);
  const newPending = start(view, [fresh]);
  await waitFor(() => expect(native.trash).toHaveBeenCalledTimes(2));
  await act(async () => { oldCommit.resolve({ relativePath: null, fileIds: [] }); expect(await oldPending).toBeUndefined(); });
  expect(view.result.current.busy).toBe(true);
  expect(native.trash.mock.calls.map(([target]) => target.relativePath)).toEqual(["old-first.md", "fresh.md"]);
  expect(toasts()).toEqual([]);
  await act(async () => {
    newCommit.resolve({ relativePath: null, fileIds: [] });
    expect(await newPending).toEqual({ succeeded: [fresh], failed: [] });
  });
  expect(view.result.current.busy).toBe(false);
  expect(toasts()).toHaveLength(1);
  expect(native.trash.mock.calls[1][0]).toMatchObject({ binding: otherScope.binding, projectId: 8 });
});
