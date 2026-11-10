import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileDropSurface } from "./FileDropSurface";
import { useFeedbackStore } from "../../state/feedback-store";
const listeners = vi.hoisted(() => [] as Array<(event: { payload: unknown }) => Promise<unknown>>);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onDragDropEvent: vi.fn(async callback => { listeners.push(callback); return () => {}; }) }) }));
const native = vi.hoisted(() => ({ ipc: vi.fn(), agent: vi.fn(), binding: vi.fn(async () => ({ workspaceId: "w", generation: "g" })) }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { fileCommand: native.ipc, command: native.agent } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: native.binding } }));
const row = { id: 4, name: "brief.md", documentId: 4, projectId: 7, managedPath: "/project/brief.md", expectedVersionNumber: 3 };
function Panel({ baseline = 3, tree = false, owner = 7 }: { baseline?: number; tree?: boolean; owner?: number | null }) {
  const root = useRef<HTMLDivElement>(null);
  return <><div ref={root} data-testid="surface"><div data-testid="row" data-file-drop-target={JSON.stringify({ ...row, expectedVersionNumber: baseline, projectId: owner })} className={tree ? "tree" : "list"}>brief.md</div><div data-testid="blank">Blank</div></div>
    <FileDropSurface workspaceRoot="/workspace" projectId={owner} elementRef={root} /></>;
}
function setup(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Panel {...props} /></QueryClientProvider>);
}
const transfer = (paths = ["/source/new.md"]) => ({ types: ["Files"], files: paths.map(path => ({ path })), getData: () => "" });
const enter = (element: HTMLElement) => fireEvent.dragOver(element, { dataTransfer: transfer() });
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }
beforeEach(() => {
  listeners.length = 0;
  native.agent.mockImplementation(async (_command, args) => ({ apiVersion: 1, requestId: args.input.requestId, ok: true, data: null }));
  vi.useFakeTimers(); native.agent.mockClear(); native.ipc.mockReset(); native.binding.mockClear(); useFeedbackStore.setState({ toasts: [] });
  native.ipc.mockImplementation(async command => command === "file_drop_prepare" ? { intentId: "intent" }
    : { documentId: 4, versionNumber: 4, contentHash: "hash", noChange: false, cleanupWarning: null });
});
const originalHitTest = document.elementFromPoint;
afterEach(() => {
  vi.useRealTimers(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalHitTest });
});
it("requires a visible 750ms hint and captures the displayed target before updating", async () => {
  setup(); enter(screen.getByTestId("row"));
  act(() => vi.advanceTimersByTime(749));
  expect(screen.queryByText(/更新此文件版本/)).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText(/更新此文件版本/)).toBeVisible();
  fireEvent.drop(screen.getByTestId("row"), { dataTransfer: transfer() }); await settle();
  expect(native.ipc.mock.calls[0]).toEqual(["file_drop_prepare", { binding: { workspaceId: "w", generation: "g" }, requestId: expect.any(String), sourcePath: "/source/new.md",
    target: { kind: "update", documentId: 4, projectId: 7, managedPath: "/project/brief.md", expectedVersionNumber: 3 } }]);
  expect(native.agent.mock.calls[0][0]).toBe("file_editors_flush");
});
it("shows the add hint over blank content and creates a Workspace File", async () => {
  setup({ owner: null }); enter(screen.getByTestId("blank"));
  expect(screen.getByText("松手移入文件，成功后原文件移至回收站")).toBeVisible();
  fireEvent.drop(screen.getByTestId("blank"), { dataTransfer: transfer() }); await settle();
  expect(native.ipc.mock.calls[0][1].target).toEqual({ kind: "new", owner: null, name: "new.md" });
});
it("limits main capture to File surfaces and leaves editor/settings handlers intact", async () => {
  const received = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><main className="workspace-content-main"><FileDropSurface workspaceRoot="/workspace" projectId={7} main /><section onDrop={received}>Settings</section><div className="project-content__file-page"><div className="markdown-file-content" onDrop={received}>Editor</div></div></main></QueryClientProvider>);
  for (const text of ["Settings", "Editor"]) fireEvent.drop(screen.getByText(text), { dataTransfer: transfer() });
  await settle();
  expect(received).toHaveBeenCalledTimes(2);
  expect(native.ipc).not.toHaveBeenCalled();
});
it.each(["quick", "before-commit"])("adds instead of replacing on a %s drop", async mode => {
  setup(); const element = screen.getByTestId("row"); enter(element);
  act(() => { vi.advanceTimersByTime(mode === "quick" ? 749 : 750); fireEvent.drop(element, { dataTransfer: transfer() }); });
  await settle();
  expect(native.ipc.mock.calls[0][1].target).toEqual({ kind: "new", owner: 7, name: "new.md" });
  expect(native.agent).not.toHaveBeenCalled();
  expect(screen.queryByText(/更新此文件版本/)).toBeNull();
});
it.each(["leave", "scroll", "resize", "layout"])("revokes a committed target after %s and requires a fresh dwell", async reason => {
  setup(); const element = screen.getByTestId("row"); enter(element);
  act(() => vi.advanceTimersByTime(750));
  expect(screen.getByText(/更新此文件版本/)).toBeVisible();
  if (reason === "leave") fireEvent.dragLeave(element, { relatedTarget: null });
  if (reason === "scroll") fireEvent.scroll(screen.getByTestId("surface"));
  if (reason === "resize") fireEvent(window, new Event("resize"));
  if (reason === "layout") { element.className = "moved"; await settle(); }
  expect(screen.queryByText(/更新此文件版本/)).toBeNull();
  fireEvent.drop(element, { dataTransfer: transfer() }); await settle();
  expect(native.ipc.mock.calls[0][1].target.kind).toBe("new");
});
it("keeps the first displayed baseline through a background metadata refresh", async () => {
  const client = new QueryClient();
  const component = (baseline: number) => <QueryClientProvider client={client}><Panel baseline={baseline} /></QueryClientProvider>;
  const view = render(component(3)); enter(screen.getByTestId("row"));
  act(() => vi.advanceTimersByTime(500)); view.rerender(component(9)); enter(screen.getByTestId("row"));
  act(() => vi.advanceTimersByTime(250));
  expect(screen.getByText(/brief.md · v3/)).toBeVisible();
  fireEvent.drop(screen.getByTestId("row"), { dataTransfer: transfer() }); await settle();
  expect(native.ipc.mock.calls[0][1].target.expectedVersionNumber).toBe(3);
});
it.each(["tree", "owner"])("revokes the old target on a %s switch", async reason => {
  const client = new QueryClient();
  const component = (changed: boolean) => <QueryClientProvider client={client}><Panel tree={reason === "tree" && changed} owner={reason === "owner" && changed ? null : 7} /></QueryClientProvider>;
  const view = render(component(false)); enter(screen.getByTestId("row")); act(() => vi.advanceTimersByTime(750));
  view.rerender(component(true)); await settle();
  expect(screen.queryByText(/更新此文件版本/)).toBeNull();
  fireEvent.drop(screen.getByTestId("row"), { dataTransfer: transfer() }); await settle();
  expect(native.ipc.mock.calls[0][1].target).toMatchObject({ kind: "new", owner: reason === "owner" ? null : 7 });
});
it.each(["multiple", "incompatible"])("rejects %s sources at a ready row without native mutation", async reason => {
  setup(); enter(screen.getByTestId("row")); act(() => vi.advanceTimersByTime(750));
  fireEvent.drop(screen.getByTestId("row"), { dataTransfer: transfer(reason === "multiple" ? ["/a.md", "/b.md"] : ["/a.pdf"]) }); await settle();
  expect(native.ipc).not.toHaveBeenCalled(); expect(native.agent).not.toHaveBeenCalled();
  expect(useFeedbackStore.getState().toasts[0].detail).toContain(reason === "multiple" ? "一次只能" : "格式不兼容");
});
it("consumes duplicate DOM drops once and retains each success, failure and cleanup warning", async () => {
  native.ipc.mockImplementation(async (command, args) => {
    if (command === "file_drop_prepare") { if (args.sourcePath === "/bad.md") throw { code: "IO_FAILED", message: "target failed" }; return { intentId: args.sourcePath }; }
    return { documentId: 4, versionNumber: 3, contentHash: "h", noChange: true, cleanupWarning: "源回收失败，原文件保留", oldSessionsClosed: false };
  });
  setup(); const blank = screen.getByTestId("blank"); enter(blank);
  const dataTransfer = transfer(["/a.md", "/bad.md"]);
  fireEvent.drop(blank, { dataTransfer }); fireEvent.drop(blank, { dataTransfer }); await settle();
  expect(native.ipc.mock.calls.filter(([command]) => command === "file_drop_prepare")).toHaveLength(2);
  expect(native.ipc.mock.calls.filter(([command]) => command === "file_drop_commit")).toHaveLength(1);
  expect(useFeedbackStore.getState().toasts).toEqual(expect.arrayContaining([
    expect.objectContaining({ tone: "success", title: "内容未变化，保留 v3", detail: expect.stringContaining("源回收失败") }),
    expect.objectContaining({ tone: "error", title: "拖入文件失败", detail: expect.stringContaining("/bad.md") }),
  ]));
});
it("retries an uncertain response from its original batch without new request or cleanup identity", async () => {
  let attempts = 0;
  native.ipc.mockImplementation(async command => {
    if (command === "file_drop_prepare") return { intentId: "frozen" };
    if (++attempts === 1) throw new Error("lost response");
    return { documentId: 4, versionNumber: 1, contentHash: "h", noChange: false, cleanupWarning: null, oldSessionsClosed: false };
  });
  setup(); fireEvent.drop(screen.getByTestId("blank"), { dataTransfer: transfer() }); await settle();
  const retry = useFeedbackStore.getState().toasts.find(toast => toast.action)?.action;
  expect(retry?.label).toBe("重试确认");
  retry!.onClick(); await settle();
  expect(native.ipc.mock.calls[2]).toEqual(native.ipc.mock.calls[1]);
  expect(native.ipc.mock.calls.filter(([command]) => command === "file_drop_prepare")).toHaveLength(1);
});

it("uses native CSS hit coordinates once, preserves dwell across repeated over and ignores DOM/native duplicates", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  setup(); const element = screen.getByTestId("row");
  const hitTest = vi.fn(() => element);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
  await settle(); expect(listeners).toHaveLength(1);
  const payload = { type: "over", position: { x: 80, y: 120 } };
  await act(async () => { await listeners[0]({ payload }); });
  act(() => vi.advanceTimersByTime(500));
  await act(async () => { await listeners[0]({ payload }); });
  act(() => vi.advanceTimersByTime(250));
  expect(screen.getByText(/更新此文件版本/)).toBeVisible();
  const drop = { payload: { type: "drop", position: payload.position, paths: ["/external/new.md"] } };
  await act(async () => {
    const first = listeners[0](drop); const duplicate = listeners[0](drop);
    fireEvent.drop(element, { dataTransfer: transfer() });
    await Promise.all([first, duplicate]);
  });
  expect(hitTest).toHaveBeenCalledWith(40, 60);
  expect(native.ipc.mock.calls.filter(([command]) => command === "file_drop_prepare")).toHaveLength(1);
  expect(native.ipc.mock.calls[0][1].target).toMatchObject({ kind: "update", expectedVersionNumber: 3 });
});
it("accepts the File preview's blank content as a new File, with move-to-Trash wording", async () => {
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><main className="workspace-content-main"><FileDropSurface workspaceRoot="/workspace" projectId={7} main /><section className="project-content__file-page"><div className="project-file-content">File preview blank</div></section></main></QueryClientProvider>);
  const blank = screen.getByText("File preview blank"); enter(blank);
  expect(screen.getByText("松手移入文件，成功后原文件移至回收站")).toBeVisible();
  fireEvent.drop(blank, { dataTransfer: transfer() }); await settle();
  expect(native.ipc.mock.calls[0][1].target.kind).toBe("new");
});
it("cancels before native prepare if owner changes while acquiring the Workspace binding", async () => {
  let resolve!: (binding: { workspaceId: string; generation: string }) => void;
  native.binding.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const client = new QueryClient();
  const component = (owner: number | null) => <QueryClientProvider client={client}><Panel owner={owner} /></QueryClientProvider>;
  const view = render(component(7)); fireEvent.drop(screen.getByTestId("blank"), { dataTransfer: transfer() });
  view.rerender(component(null)); await act(async () => resolve({ workspaceId: "w", generation: "g" })); await settle();
  expect(native.ipc).not.toHaveBeenCalled();
});
