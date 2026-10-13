import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, within, createEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAgentPanelStore, dshProjectRunKey } from "../../state/agent-panel-store";
import { getContentLayout } from "../../lib/project-content-layout";
import { useProjectContentStore } from "../../state/project-content-store";
import { ProjectContentLayoutView, type ContentPageProps } from "./ProjectContentLayoutView";
import projectContentCss from "./project-content.css?raw";

const scope = { workspaceId: "layout-workspace", projectId: 7 };
let width = 1000;
const observers: Array<{ callback: () => void; targets: Element[] }> = [];
const mounts = vi.fn();
const guard = vi.fn(async () => undefined);
function Editor({ tab, visible, focused, registerCloseGuard }: ContentPageProps) {
  const [draft, setDraft] = useState("");
  useEffect(() => { mounts(tab.object.id); }, []);
  useEffect(() => registerCloseGuard(guard), [registerCloseGuard]);
  return <div data-testid={`page-${tab.object.id}`} data-visible={String(visible)} data-focused={String(focused)}>
    <input aria-label={`草稿${tab.object.title}`} value={draft} onChange={event => setDraft(event.target.value)} />
    <div role="dialog"><button>弹窗操作</button></div>
  </div>;
}
function Harness({ active = true, contentScope = scope }: { active?: boolean; contentScope?: typeof scope }) {
  const layout = useProjectContentStore(state => getContentLayout(state, contentScope));
  return <ProjectContentLayoutView scope={contentScope} layout={layout} active={active} onOverview={vi.fn()}
    onSelect={(pane, id) => useProjectContentStore.getState().select(contentScope, pane, id)}
    onClose={async (id, beforeClose) => { await beforeClose?.(); useProjectContentStore.getState().close(contentScope, id); }}
    renderPage={props => <Editor {...props} />} />;
}
function open(id: number, title: string) { return useProjectContentStore.getState().open(scope, { kind: "record", id, title }); }
function resize() { act(() => { for (const observer of observers) observer.callback(); }); }
beforeEach(() => {
  vi.clearAllMocks(); guard.mockResolvedValue(undefined);
  useAgentPanelStore.getState().clearWorkspace();
  useProjectContentStore.setState({ layouts: {} }); width = 1000; observers.length = 0;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () { return this.classList.contains("project-content") ? width : 300; });
  vi.stubGlobal("ResizeObserver", class {
    entry: { callback: () => void; targets: Element[] };
    constructor(callback: () => void) { this.entry = { callback, targets: [] }; observers.push(this.entry); }
    observe(target: Element) { this.entry.targets.push(target); }
    disconnect() {} unobserve() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("shows both selected pages but focuses only the pane the user operates", () => {
  open(1, "甲"); open(2, "乙"); render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "分栏" }));
  expect(screen.getByTestId("page-1")).toBeVisible(); expect(screen.getByTestId("page-2")).toBeVisible();
  expect(screen.getByTestId("page-1")).toHaveAttribute("data-focused", "false");
  expect(screen.getByTestId("page-2")).toHaveAttribute("data-focused", "true");
  fireEvent.pointerDown(screen.getByLabelText("草稿甲"));
  expect(screen.getByTestId("page-1")).toHaveAttribute("data-focused", "true");
  expect(screen.getByTestId("page-2")).toHaveAttribute("data-focused", "false");
  const view = screen.getByTestId("page-1");
  expect(view).toHaveAttribute("data-visible", "true");
});
it("selects and drags through the full tab surface, while closing never selects it", async () => {
  const a = open(1, "短名"); const b = open(2, "另一条内容"); render(<Harness />);
  const surface = screen.getByRole("tab", { name: "短名" }).closest<HTMLElement>(".project-content__tab")!;
  fireEvent.click(surface);
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].selectedTabId).toBe(a);
  pointer("pointerDown", surface, { clientX: 120, clientY: 15 });
  expect(screen.getByRole("tab", { name: "短名" })).toHaveFocus();
  pointer("pointerCancel", window, { clientX: 120, clientY: 15 });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "关闭另一条内容" })));
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].selectedTabId).toBe(a);
  expect(getContentLayout(useProjectContentStore.getState(), scope).tabs.some(tab => tab.id === b)).toBe(false);
});
it("removes the long-title mask after a background rename without remounting the page", () => {
  const id = open(1, "长标题在后台更名");
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function () { return this.classList.contains("compact-tab__label") && this.textContent?.startsWith("长标题") ? 900 : 20; });
  render(<Harness />);
  expect(screen.getByText("长标题在后台更名")).toHaveAttribute("data-clipped");
  act(() => useProjectContentStore.getState().updateTitle(scope, id, "短名"));
  expect(screen.getByText("短名")).not.toHaveAttribute("data-clipped");
  expect(mounts).toHaveBeenCalledTimes(1);
});
it("moves and merges an existing editor without remounting or losing its draft", () => {
  open(1, "甲"); open(2, "乙"); render(<Harness />);
  const input = screen.getByLabelText("草稿乙"); fireEvent.change(input, { target: { value: "未保存的编辑" } });
  fireEvent.click(screen.getByRole("button", { name: "分栏" }));
  fireEvent.keyDown(screen.getByRole("tab", { name: "乙" }), { altKey: true, shiftKey: true, ctrlKey: true, key: "ArrowLeft" });
  expect(within(screen.getByRole("tablist", { name: "左栏内容" })).getByRole("tab", { name: "乙" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: "合并分栏" }));
  expect(screen.getByLabelText("草稿乙")).toBe(input); expect(input).toHaveValue("未保存的编辑");
  expect(mounts.mock.calls.filter(([id]) => id === 2)).toHaveLength(1);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
});
it("temporarily hides the other pane on narrow resize and restores its selection, ratio and state", () => {
  open(1, "甲"); open(2, "乙"); useProjectContentStore.getState().split(scope);
  useProjectContentStore.getState().setRatio(scope, 0.6); render(<Harness />);
  const input = screen.getByLabelText("草稿甲"); fireEvent.change(input, { target: { value: "左栏状态" } });
  width = 600; resize();
  expect(input).not.toBeVisible(); expect(screen.getByLabelText("草稿乙")).toBeVisible();
  expect(screen.queryByRole("separator")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "切换另一栏" }));
  expect(input).toBeVisible(); expect(screen.getByLabelText("草稿乙")).not.toBeVisible();
  width = 1000; resize();
  expect(screen.getByLabelText("草稿甲")).toBe(input); expect(input).toHaveValue("左栏状态");
  expect(screen.getByLabelText("草稿乙")).toBeVisible();
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "60");
  expect(screen.getAllByRole("tablist")).toHaveLength(2); expect(mounts).toHaveBeenCalledTimes(2);
});
it("retains the tab and draft when its close guard fails, then permits retry", async () => {
  open(1, "甲"); render(<Harness />); const input = screen.getByLabelText("草稿甲");
  fireEvent.change(input, { target: { value: "必须保留" } }); guard.mockRejectedValueOnce(new Error("保存冲突"));
  fireEvent.click(screen.getByRole("button", { name: "关闭甲" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存冲突");
  expect(screen.getByRole("tab", { name: "甲" })).toBeVisible(); expect(input).toHaveValue("必须保留");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "关闭甲" })));
  expect(screen.queryByRole("tab", { name: "甲" })).toBeNull(); expect(guard).toHaveBeenCalledTimes(2);
});
it("keeps panes readable on resize without replacing the saved wide-window ratio", () => {
  open(1, "甲"); open(2, "乙"); useProjectContentStore.getState().split(scope);
  width = 2000; useProjectContentStore.getState().setRatio(scope, 0.2); render(<Harness />);
  width = 800; resize();
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "40");
  expect(getContentLayout(useProjectContentStore.getState(), scope).ratio).toBe(0.2);
  width = 2000; resize();
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "20");
});
it("targets the focused page shortcut and lets a dialog handle its own key", async () => {
  open(1, "甲"); open(2, "乙"); useProjectContentStore.getState().split(scope); render(<Harness />);
  fireEvent.keyDown(within(screen.getByTestId("page-2")).getByText("弹窗操作"), { altKey: true, key: "w" });
  expect(guard).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(screen.getByLabelText("草稿乙"), { altKey: true, key: "w" }));
  expect(screen.queryByRole("tab", { name: "乙" })).toBeNull(); expect(screen.getByRole("tab", { name: "甲" })).toBeVisible();
});
it("updates horizontal edge masks at both scroll boundaries, in reverse, and after content or viewport resize", () => {
  open(1, "甲"); open(2, "乙"); render(<Harness />);
  const list = screen.getByRole("tablist"); const viewport = list.parentElement!; const frame = viewport.parentElement!;
  let contentWidth = 700; let viewportWidth = 300;
  Object.defineProperties(viewport, { scrollWidth: { configurable: true, get: () => contentWidth }, clientWidth: { configurable: true, get: () => viewportWidth } });
  const masks = () => [frame.style.getPropertyValue("--tab-fade-left"), frame.style.getPropertyValue("--tab-fade-right")].map(Number);
  resize(); expect(masks()).toEqual([0, 1]);
  viewport.scrollLeft = 32; fireEvent.scroll(viewport); const partial = masks()[0]; expect(partial).toBeGreaterThan(0); expect(partial).toBeLessThan(1);
  viewport.scrollLeft = 400; fireEvent.scroll(viewport); expect(masks()).toEqual([1, 0]);
  viewport.scrollLeft = 368; fireEvent.scroll(viewport); expect(masks()[1]).toBeGreaterThan(0); expect(masks()[1]).toBeLessThan(1);
  viewport.scrollLeft = 0; fireEvent.scroll(viewport); expect(masks()).toEqual([0, 1]);
  viewportWidth = 800; resize(); expect(masks()).toEqual([0, 0]);
  contentWidth = 1200; resize(); expect(masks()).toEqual([0, 1]);
  expect(observers.some(observer => observer.targets.includes(list) && observer.targets.includes(viewport))).toBe(true);
});
it("switches one pane independently and keeps a background title refresh from taking focus", () => {
  const first = open(1, "甲"); open(2, "乙"); useProjectContentStore.getState().split(scope);
  useProjectContentStore.getState().focus(scope, "left"); const third = open(3, "丙"); render(<Harness />);
  const other = screen.getByLabelText("草稿乙"); fireEvent.change(other, { target: { value: "另一栏正文" } });
  fireEvent.click(screen.getByRole("tab", { name: "甲" }));
  expect(screen.getByLabelText("草稿甲")).toBeVisible(); expect(screen.getByLabelText("草稿丙")).not.toBeVisible();
  expect(other).toBeVisible(); expect(other).toHaveValue("另一栏正文");
  act(() => useProjectContentStore.getState().updateTitle(scope, third, "后台标题更新"));
  expect(screen.getByTestId("page-1")).toHaveAttribute("data-focused", "true");
  expect(screen.getByTestId("page-2")).toHaveAttribute("data-focused", "false");
  expect(screen.getByRole("tab", { name: "甲" })).toHaveAttribute("aria-controls", `content-page-${first}`);
  expect(screen.getAllByRole("tablist")).toHaveLength(2);
});
it("clears both visibility and focus for an inactive Project without remounting its editors", () => {
  open(1, "甲"); open(2, "乙"); useProjectContentStore.getState().split(scope);
  const view = render(<Harness />); const input = screen.getByLabelText("草稿甲");
  view.rerender(<Harness active={false} />);
  expect(input).not.toBeVisible(); expect(screen.getByLabelText("草稿乙")).not.toBeVisible();
  for (const id of [1, 2]) {
    expect(screen.getByTestId(`page-${id}`)).toHaveAttribute("data-visible", "false");
    expect(screen.getByTestId(`page-${id}`)).toHaveAttribute("data-focused", "false");
  }
  view.rerender(<Harness />); expect(screen.getByLabelText("草稿甲")).toBe(input); expect(input).toBeVisible();
  expect(mounts).toHaveBeenCalledTimes(2);
});

it("reorders with keyboard without a menu and transfers to the other pane with its draft intact", () => {
  const a = open(1, "甲"); const b = open(2, "乙"); open(3, "丙"); render(<Harness />);
  fireEvent.keyDown(screen.getByRole("tab", { name: "乙" }), { altKey: true, shiftKey: true, key: "ArrowLeft" });
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].tabIds.slice(0, 2)).toEqual([b, a]);
  expect(screen.queryByRole("button", { name: "乙的操作" })).toBeNull();
  expect(screen.getByRole("tab", { name: "乙" })).toHaveFocus();
});
function pointer(type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", node: Element | Window, values: Record<string, number>) {
  const event = createEvent[type](node, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ pointerId: 1, button: 0, ...values })) Object.defineProperty(event, key, { value });
  fireEvent(node, event);
}
it("drops before and after a tab and across panes rather than always inserting before", () => {
  const a = open(1, "甲"); const b = open(2, "乙"); const c = open(3, "丙"); render(<Harness />);
  const left = screen.getByRole("tablist").parentElement!;
  vi.spyOn(left, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 42));
  for (const [i, name] of ["甲", "乙", "丙"].entries()) vi.spyOn(screen.getByRole("tab", { name }).closest<HTMLElement>(".project-content__tab")!, "getBoundingClientRect").mockReturnValue(new DOMRect(i * 100, 0, 100, 32));
  const capture = captureTab(screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!);
  pointer("pointerDown", screen.getByRole("tab", { name: "甲" }), { clientX: 30, clientY: 15 });
  pointer("pointerMove", window, { clientX: 180, clientY: 15 });
  expect(screen.getByRole("tab", { name: "乙" }).closest<HTMLElement>(".project-content__tab")!).toHaveAttribute("data-drop", "after");
  pointer("pointerUp", window, { clientX: 180, clientY: 15 });
  expect(capture.release).toHaveBeenCalledWith(1);
  expect(previewNode()).toHaveAttribute("hidden");
  expect(previewNode()).toBeEmptyDOMElement();
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].tabIds).toEqual([b, a, c]);
  fireEvent.click(screen.getByRole("button", { name: "分栏" }));
  const right = screen.getByRole("tablist", { name: "右栏内容" }).parentElement!;
  vi.spyOn(right, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 0, 500, 42));
  vi.spyOn(screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 0, 100, 32));
  pointer("pointerDown", screen.getByRole("tab", { name: "乙" }), { clientX: 30, clientY: 15 });
  pointer("pointerMove", window, { clientX: 680, clientY: 15 });
  pointer("pointerUp", window, { clientX: 680, clientY: 15 });
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[1].tabIds).toEqual([a, b]);
  expect(mounts).toHaveBeenCalledTimes(3);
});
it("temporarily maximizes a pane, preserves layout authority and drafts, and defers Escape to editors and dialogs", () => {
  open(1, "甲"); open(2, "乙"); useProjectContentStore.getState().split(scope);
  useProjectContentStore.getState().setRatio(scope, 0.6); render(<Harness />);
  const original = getContentLayout(useProjectContentStore.getState(), scope);
  const input = screen.getByLabelText("草稿甲"); fireEvent.change(input, { target: { value: "保留" } });
  fireEvent.click(screen.getByRole("button", { name: "放大当前栏" }));
  expect(input).not.toBeVisible(); expect(screen.getByLabelText("草稿乙")).toBeVisible();
  expect(getContentLayout(useProjectContentStore.getState(), scope)).toBe(original);
  fireEvent.keyDown(screen.getByLabelText("草稿乙"), { key: "Escape" });
  fireEvent.keyDown(within(screen.getByTestId("page-2")).getByText("弹窗操作"), { key: "Escape" });
  expect(screen.getByRole("button", { name: "恢复双栏" })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("tab", { name: "乙" }), { key: "Escape" });
  expect(input).toBeVisible(); expect(input).toHaveValue("保留"); expect(mounts).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "60");
});
it("marks only the exact running Session and exposes file format and object types", () => {
  useAgentPanelStore.getState().bindWorkspace("/workspace");
  useAgentPanelStore.getState().setSessionRuns("/workspace", 7, { alpha: true, beta: false });
  useProjectContentStore.getState().open(scope, { kind: "session", id: "alpha", title: "运行会话" });
  useProjectContentStore.getState().open(scope, { kind: "session", id: "beta", title: "空闲会话" });
  useProjectContentStore.getState().open(scope, { kind: "file", id: 3, title: "计划.md" }); render(<Harness />);
  expect(screen.getByRole("tab", { name: "运行会话" }).closest(".project-content__tab")).toHaveAttribute("data-running", "true");
  expect(screen.getByRole("tab", { name: "空闲会话" }).closest(".project-content__tab")).not.toHaveAttribute("data-running");
  expect(screen.getByRole("tab", { name: "计划.md" })).toHaveAttribute("title", expect.stringContaining("Markdown"));
  act(() => useAgentPanelStore.getState().setSessionRuns("/workspace", 7, {}));
  expect(screen.getByRole("tab", { name: "运行会话" }).closest(".project-content__tab")).not.toHaveAttribute("data-running");
  expect(useAgentPanelStore.getState().sessionsByProject[dshProjectRunKey("/workspace", 7)]).toBeUndefined();
});
it("reveals the selected tab after route selection and keyboard navigation", () => {
  const a = open(1, "甲"); open(2, "乙"); render(<Harness />);
  const viewport = screen.getByRole("tablist").parentElement!;
  Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 1000 });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 36));
  vi.spyOn(screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 0, 120, 30));
  act(() => useProjectContentStore.getState().select(scope, "left", a));
  expect(viewport.scrollLeft).toBeGreaterThan(0);
});
it("translates wheel scrolling only while tabs can actually scroll", () => {
  open(1, "甲"); render(<Harness />); const viewport = screen.getByRole("tablist").parentElement!;
  Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 700 });
  const wheel = createEvent.wheel(viewport, { deltaY: 80, cancelable: true }); fireEvent(viewport, wheel);
  expect(viewport.scrollLeft).toBe(80); expect(wheel.defaultPrevented).toBe(true);
  viewport.scrollLeft = 400;
  const edge = createEvent.wheel(viewport, { deltaY: 80, cancelable: true }); fireEvent(viewport, edge);
  expect(edge.defaultPrevented).toBe(false);
});

it("auto scrolls during a held drag near the strip edge and stops at the boundary or drag end", () => {
  open(1, "甲"); open(2, "乙"); render(<Harness />);
  const viewport = screen.getByRole("tablist").parentElement!;
  Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 700 });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 42));
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const tick = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); });
  pointer("pointerDown", screen.getByRole("tab", { name: "甲" }), { clientX: 30, clientY: 15 });
  pointer("pointerMove", window, { clientX: 298, clientY: 15 });
  tick(); expect(viewport.scrollLeft).toBeGreaterThan(0); expect(frames.size).toBe(1);
  tick(); expect(viewport.scrollLeft).toBeGreaterThan(10);
  viewport.scrollLeft = 399; tick(); expect(viewport.scrollLeft).toBe(400);
  tick(); expect(frames.size).toBe(0);
  pointer("pointerMove", window, { clientX: 2, clientY: 15 });
  tick(); expect(viewport.scrollLeft).toBeLessThan(400);
  pointer("pointerCancel", window, { clientX: 2, clientY: 15 }); expect(frames.size).toBe(0);
});
it.each([false, true])("uses a 220ms transform-only FLIP for maximize/restore and honors reduced motion=%s", reduced => {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (!this.classList.contains("project-content__page")) return new DOMRect();
    const expanded = this.closest(".project-content")?.hasAttribute("data-maximized");
    const right = this.dataset.contentObject === "record:2";
    return new DOMRect(expanded ? 0 : right ? 600 : 0, 42, expanded ? 1000 : right ? 400 : 600, 500);
  });
  try {
    open(1, "甲"); open(2, "乙"); useProjectContentStore.getState().split(scope); render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "放大当前栏" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复双栏" }));
    if (reduced) expect(animate).not.toHaveBeenCalled();
    else {
      expect(animate).toHaveBeenCalledTimes(2);
      for (const [frames, options] of animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][]) {
        expect(options.duration).toBe(220);
        expect(Object.keys(frames[0])).toEqual(["transform", "transformOrigin"]);
      }
    }
  } finally {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("drops before a target, permits an empty destination pane, and cancels Escape without changing layout", () => {
  const a = open(1, "甲"); const b = open(2, "乙"); render(<Harness />);
  const viewport = screen.getByRole("tablist").parentElement!;
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 42));
  vi.spyOn(screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 32));
  vi.spyOn(screen.getByRole("tab", { name: "乙" }).closest<HTMLElement>(".project-content__tab")!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 100, 32));
  pointer("pointerDown", screen.getByRole("tab", { name: "乙" }), { clientX: 150, clientY: 15 });
  pointer("pointerMove", window, { clientX: 20, clientY: 15 });
  expect(screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!).toHaveAttribute("data-drop", "before");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!).not.toHaveAttribute("data-drop");
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].tabIds).toEqual([a, b]);
  pointer("pointerDown", screen.getByRole("tab", { name: "乙" }), { clientX: 150, clientY: 15 });
  pointer("pointerMove", window, { clientX: 20, clientY: 15 });
  pointer("pointerUp", window, { clientX: 20, clientY: 15 });
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].tabIds).toEqual([b, a]);
  fireEvent.click(screen.getByRole("button", { name: "分栏" }));
  act(() => useProjectContentStore.getState().move(scope, b, "left"));
  const right = screen.getByRole("tablist", { name: "右栏内容" }).parentElement!;
  vi.spyOn(right, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 0, 500, 42));
  pointer("pointerDown", screen.getByRole("tab", { name: "甲" }), { clientX: 20, clientY: 15 });
  pointer("pointerMove", window, { clientX: 600, clientY: 15 });
  expect(right.parentElement).toHaveAttribute("data-drop-empty");
  pointer("pointerUp", window, { clientX: 600, clientY: 15 });
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[1].tabIds).toEqual([a]);
});
it("restores from toolbar Escape and keeps narrow mode's automatic single pane distinct", () => {
  open(1, "甲"); open(2, "乙"); useProjectContentStore.getState().split(scope); render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "放大当前栏" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "恢复双栏" }), { key: "Escape" });
  expect(screen.getByLabelText("草稿甲")).toBeVisible();
  width = 600; resize();
  expect(screen.queryByRole("button", { name: "放大当前栏" })).toBeNull();
  expect(screen.getByRole("button", { name: "切换另一栏" })).toBeVisible();
});

it("keeps a manually scrolled strip while the selected page saves view metadata, and reveals again on selection", () => {
  const a = open(1, "甲"); const b = open(2, "乙"); render(<Harness />);
  const viewport = screen.getByRole("tablist").parentElement!;
  Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 1000 });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 42));
  vi.spyOn(screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!, "getBoundingClientRect").mockImplementation(() => new DOMRect(-viewport.scrollLeft, 0, 100, 32));
  viewport.scrollLeft = 250; fireEvent.scroll(viewport);
  act(() => useProjectContentStore.getState().updateView(scope, b, { scrollTop: 1200 }));
  expect(viewport.scrollLeft).toBe(250);
  act(() => useProjectContentStore.getState().select(scope, "left", a));
  expect(viewport.scrollLeft).toBe(0);
});
it("portals the drag preview outside the contained, clipped content layout", () => {
  open(1, "甲"); render(<Harness />);
  const preview = document.querySelector(".project-content__drag-preview")!;
  expect(preview.parentElement).toBe(document.body);
  expect(screen.getByLabelText("项目内容")).not.toContainElement(preview as HTMLElement);
});

function captureTab(tab: HTMLElement) {
  let captured = false;
  const set = vi.fn(() => { captured = true; });
  const release = vi.fn(() => { captured = false; });
  Object.defineProperties(tab, {
    setPointerCapture: { configurable: true, value: set },
    hasPointerCapture: { configurable: true, value: () => captured },
    releasePointerCapture: { configurable: true, value: release },
  });
  return { set, release, isCaptured: () => captured };
}
const previewNode = () => document.querySelector<HTMLDivElement>(".project-content__drag-preview")!;
function artworkMarkup(icon: Element) {
  const copy = icon.cloneNode(true) as Element;
  for (const element of [copy, ...copy.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      if (["style", "tabindex", "role", "id"].includes(attribute.name) || attribute.name.startsWith("aria-")) element.removeAttribute(attribute.name);
    }
  }
  return copy.outerHTML;
}

it("explicitly uses an arrow on the surface and trigger, and grabbing only during a drag", () => {
  const styles = document.createElement("style");
  styles.textContent = `button { cursor: pointer; } ${projectContentCss}`;
  document.head.append(styles);
  try {
    open(1, "甲"); render(<Harness />);
    const trigger = screen.getByRole("tab", { name: "甲" });
    const surface = trigger.closest<HTMLElement>(".project-content__tab")!;
    fireEvent.mouseEnter(surface);
    expect(getComputedStyle(surface).cursor).toBe("default");
    expect(getComputedStyle(trigger).cursor).toBe("default");
    pointer("pointerDown", trigger, { clientX: 20, clientY: 15 });
    pointer("pointerMove", window, { clientX: 50, clientY: 15 });
    expect(getComputedStyle(surface).cursor).toBe("grabbing");
    expect(getComputedStyle(trigger).cursor).toBe("grabbing");
    expect(getComputedStyle(previewNode()).opacity).toBe("0.65");
    pointer("pointerCancel", window, {});
    expect(getComputedStyle(trigger).cursor).toBe("default");
  } finally { styles.remove(); }
});

it.each([
  ["record", "短名", 96, false],
  ["record", "记录长标题必须保留完整内容且沿用真实截断遮罩", 148, true],
  ["session", "运行会话", 110, false],
  ["session", "运行中的会话长标题必须连同运行标记保持原样", 132, true],
  ["file", "计划.md", 105, false],
  ["file", "计划文件长标题必须保持原格式图标及版本信息.md", 148, true],
  ["file", "原件.unknown", 120, false],
] as const)("copies the full %s tab %s with measured geometry and its top-left at the pointer", (kind, title, tabWidth, clipped) => {
  useAgentPanelStore.getState().bindWorkspace("/workspace");
  useAgentPanelStore.getState().setSessionRuns("/workspace", 7, { alpha: true });
  const id = useProjectContentStore.getState().open(scope, kind === "session"
    ? { kind, id: "alpha", title } : { kind, id: 1, title });
  if (kind === "file") useProjectContentStore.getState().updateView(scope, id, { versionNumber: 3 });
  const client = new QueryClient();
  client.setQueryData(["native-file-type-icon", "unknown"], "data:image/png;base64,aWNvbg==");
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  const trigger = screen.getByRole("tab", { name: title });
  const source = trigger.closest<HTMLElement>(".project-content__tab")!;
  const capture = captureTab(source);
  // jsdom has no layout engine: supply the observed browser rect and resolved styles.
  vi.spyOn(source, "getBoundingClientRect").mockReturnValue(new DOMRect(210, 74, tabWidth, 30));
  Object.assign(source.style, { backgroundColor: "rgb(230, 231, 232)", borderRadius: "8px", color: "rgb(20, 21, 22)", padding: "0 2px 0 6px", boxSizing: "border-box" });
  const body = source.querySelector<HTMLElement>(".compact-tab__body")!;
  Object.assign(body.style, { position: "relative", width: `${tabWidth - 8}px`, height: "30px", display: "flex" });
  Object.assign(trigger.style, { display: "flex", gap: "4px", padding: "0 2px 0 0", height: "30px", outline: "2px solid red", boxShadow: "0 0 0 2px red" });
  const label = source.querySelector<HTMLElement>(".compact-tab__label")!;
  label.toggleAttribute("data-clipped", clipped);
  Object.assign(label.style, { width: `${tabWidth - 28}px`, overflow: "hidden", whiteSpace: "nowrap", maskImage: clipped ? "linear-gradient(to right, black calc(100% - 34px), transparent calc(100% - 22px))" : "none" });
  const close = source.querySelector<HTMLElement>(".compact-tab__close")!;
  Object.assign(close.style, { position: "absolute", right: "0px", top: "50%", transform: "translateY(-50%)", width: "20px", height: "22px", opacity: "0.8", boxShadow: "0 0 0 2px red" });
  const icon = source.querySelector<HTMLElement | SVGElement>(".project-content__tab-icon")!;
  const iconMarkup = artworkMarkup(icon);
  const closeMarkup = artworkMarkup(close.querySelector("svg")!);
  source.dataset.drop = "after";
  pointer("pointerDown", trigger, { clientX: 237, clientY: 83 });
  expect(previewNode()).toBeEmptyDOMElement();
  pointer("pointerMove", window, { clientX: 249, clientY: 88 });
  const preview = previewNode(), snapshot = preview.firstElementChild as HTMLElement;
  expect(preview).not.toHaveAttribute("hidden");
  expect(preview.style.transform).toBe("translate(249px, 88px)");
  expect(snapshot).toHaveStyle({ width: `${tabWidth}px`, "min-width": `${tabWidth}px`, "max-width": `${tabWidth}px`, height: "30px", "min-height": "30px", "max-height": "30px", "background-color": "rgb(230, 231, 232)", "border-radius": "8px", padding: "0px 2px 0px 6px", "box-sizing": "border-box" });
  expect(snapshot.querySelector(".compact-tab__body")).toHaveStyle({ width: `${tabWidth - 8}px`, height: "30px", position: "relative" });
  const copiedLabel = snapshot.querySelector<HTMLElement>(".compact-tab__label")!;
  expect(copiedLabel.textContent).toBe(label.textContent);
  expect(copiedLabel.hasAttribute("data-clipped")).toBe(clipped);
  expect(copiedLabel.style.maskImage).toBe(getComputedStyle(label).maskImage);
  expect(artworkMarkup(snapshot.querySelector(".project-content__tab-icon")!)).toBe(iconMarkup);
  expect(artworkMarkup(snapshot.querySelector(".compact-tab__close svg")!)).toBe(closeMarkup);
  expect(snapshot.querySelector(".compact-tab__close")).toHaveStyle({ right: "0px", top: "50%", transform: "translateY(-50%)", width: "20px", height: "22px", opacity: "0.8" });
  if (kind === "session") expect(snapshot.querySelector(".project-content__running")).not.toBeNull();
  if (kind === "file") expect(snapshot.querySelector("small")).toHaveTextContent("v3");
  if (title.endsWith(".unknown")) expect(snapshot.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,aWNvbg==");
  expect(preview.querySelector("[id], [role], [aria-controls], [aria-labelledby], [data-drop], [data-tab-id]")).toBeNull();
  expect(preview).toHaveAttribute("aria-hidden", "true");
  expect(preview).toHaveAttribute("inert");
  expect(snapshot.inert).toBe(true);
  expect(snapshot.querySelector("button")).toHaveAttribute("tabindex", "-1");
  expect(snapshot.querySelector(".compact-tab__trigger")).toHaveStyle({ outline: "none", "box-shadow": "none", transition: "none" });
  expect(snapshot.querySelector(".compact-tab__close")).toHaveStyle({ outline: "none", "box-shadow": "none" });
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  source.style.backgroundColor = "rgb(1, 2, 3)";
  label.style.maskImage = "none";
  pointer("pointerMove", window, { clientX: 180, clientY: 62 });
  expect(preview.style.transform).toBe("translate(180px, 62px)");
  expect(preview.firstElementChild).toBe(snapshot);
  expect(snapshot.style.backgroundColor).toBe("rgb(230, 231, 232)");
  if (clipped) expect(copiedLabel.style.maskImage).not.toBe("none");
  pointer("pointerCancel", window, {});
  expect(preview).toHaveAttribute("hidden");
  expect(preview).toBeEmptyDOMElement();
  expect(capture.release).toHaveBeenCalledWith(1);
  client.clear();
});

it.each(["Escape", "pointerCancel", "pointerUp", "blur", "scope", "inactive", "unmount"] as const)("cleans the preview, pointer capture and drag lifecycle on %s", ending => {
  const a = open(1, "甲"), b = open(2, "乙");
  const view = render(<Harness />);
  const trigger = screen.getByRole("tab", { name: "甲" });
  const source = trigger.closest<HTMLElement>(".project-content__tab")!;
  const capture = captureTab(source);
  pointer("pointerDown", trigger, { clientX: 20, clientY: 15 });
  pointer("pointerMove", window, { clientX: 60, clientY: 15 });
  const preview = previewNode();
  expect(preview.childElementCount).toBe(1);
  expect(capture.isCaptured()).toBe(true);
  if (ending === "Escape") fireEvent.keyDown(window, { key: "Escape" });
  else if (ending === "blur") fireEvent(window, new Event("blur"));
  else if (ending === "scope") view.rerender(<Harness contentScope={{ ...scope, projectId: 8 }} />);
  else if (ending === "inactive") view.rerender(<Harness active={false} />);
  else if (ending === "unmount") view.unmount();
  else pointer(ending, window, { clientX: 60, clientY: 15 });
  expect(capture.release).toHaveBeenCalledTimes(1);
  expect(capture.isCaptured()).toBe(false);
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].tabIds).toEqual([a, b]);
  if (ending === "unmount") expect(previewNode()).toBeNull();
  else {
    expect(preview).toBeEmptyDOMElement();
    expect(preview).toHaveAttribute("hidden");
    expect(preview.style.transform).toBe("");
    expect(screen.getByLabelText("项目内容")).not.toHaveAttribute("data-dragging");
  }
  pointer("pointerMove", window, { clientX: 90, clientY: 15 });
  expect(capture.release).toHaveBeenCalledTimes(1);
  if (ending !== "unmount") expect(preview).toBeEmptyDOMElement();
});

it("keeps a click below the movement threshold and ignores other pointers during dragging", () => {
  const a = open(1, "甲"), b = open(2, "乙"); render(<Harness />);
  const trigger = screen.getByRole("tab", { name: "甲" });
  const capture = captureTab(trigger.closest<HTMLElement>(".project-content__tab")!);
  pointer("pointerDown", trigger, { clientX: 20, clientY: 15 });
  pointer("pointerMove", window, { clientX: 23, clientY: 18 });
  expect(previewNode()).toHaveAttribute("hidden");
  expect(previewNode()).toBeEmptyDOMElement();
  pointer("pointerUp", window, { clientX: 23, clientY: 18 });
  fireEvent.click(trigger);
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].selectedTabId).toBe(a);
  pointer("pointerDown", trigger, { clientX: 20, clientY: 15 });
  pointer("pointerMove", window, { clientX: 60, clientY: 15 });
  const snapshot = previewNode().firstElementChild;
  pointer("pointerMove", window, { pointerId: 2, clientX: 180, clientY: 25 });
  pointer("pointerCancel", window, { pointerId: 2 });
  expect(previewNode().firstElementChild).toBe(snapshot);
  expect(capture.isCaptured()).toBe(true);
  pointer("pointerCancel", window, {});
  fireEvent.click(screen.getByRole("tab", { name: "乙" }));
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].selectedTabId).toBe(b);
});

it("suppresses the synthetic surface click after dragging from tab padding across panes", () => {
  const a = open(1, "甲"), b = open(2, "乙");
  useProjectContentStore.getState().split(scope);
  const select = vi.spyOn(useProjectContentStore.getState(), "select");
  render(<Harness />);
  const source = screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!;
  const left = screen.getByRole("tablist", { name: "左栏内容" }).parentElement!;
  const right = screen.getByRole("tablist", { name: "右栏内容" }).parentElement!;
  vi.spyOn(left, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 42));
  vi.spyOn(right, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 0, 500, 42));
  vi.spyOn(source, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 6, 96, 30));
  vi.spyOn(screen.getByRole("tab", { name: "乙" }).closest<HTMLElement>(".project-content__tab")!, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(500, 6, 96, 30));
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  pointer("pointerDown", source, { clientX: 3, clientY: 15 });
  pointer("pointerMove", window, { clientX: 650, clientY: 15 });
  pointer("pointerUp", window, { clientX: 650, clientY: 15 });
  const dropped = getContentLayout(useProjectContentStore.getState(), scope);
  expect(dropped.panes[0].tabIds).toEqual([]);
  expect(dropped.panes[1].tabIds).toEqual([b, a]);
  expect(dropped.focusedPaneId).toBe("right");
  select.mockClear();
  const surface = screen.getByRole("tab", { name: "甲" }).closest<HTMLElement>(".project-content__tab")!;
  const click = createEvent.click(surface, { bubbles: true, cancelable: true });
  fireEvent(surface, click);
  expect(click.defaultPrevented).toBe(true);
  expect(select).not.toHaveBeenCalled();
  expect(getContentLayout(useProjectContentStore.getState(), scope)).toBe(dropped);
  act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); });
  fireEvent.click(surface);
  expect(select).toHaveBeenCalledWith(scope, "right", a);
});
