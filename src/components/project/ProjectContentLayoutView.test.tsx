import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, within, createEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentPanelStore, dshProjectRunKey } from "../../state/agent-panel-store";
import { getContentLayout } from "../../lib/project-content-layout";
import { useProjectContentStore } from "../../state/project-content-store";
import { ProjectContentLayoutView, type ContentPageProps } from "./ProjectContentLayoutView";

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
function Harness({ active = true }: { active?: boolean }) {
  const layout = useProjectContentStore(state => getContentLayout(state, scope));
  return <ProjectContentLayoutView scope={scope} layout={layout} active={active} onOverview={vi.fn()}
    onSelect={(pane, id) => useProjectContentStore.getState().select(scope, pane, id)}
    onClose={async (id, beforeClose) => { await beforeClose?.(); useProjectContentStore.getState().close(scope, id); }}
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
  for (const [i, name] of ["甲", "乙", "丙"].entries()) vi.spyOn(screen.getByRole("tab", { name }).parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(i * 100, 0, 100, 32));
  pointer("pointerDown", screen.getByRole("tab", { name: "甲" }), { clientX: 30, clientY: 15 });
  pointer("pointerMove", window, { clientX: 180, clientY: 15 });
  expect(screen.getByRole("tab", { name: "乙" }).parentElement!).toHaveAttribute("data-drop", "after");
  pointer("pointerUp", window, { clientX: 180, clientY: 15 });
  expect(getContentLayout(useProjectContentStore.getState(), scope).panes[0].tabIds).toEqual([b, a, c]);
  fireEvent.click(screen.getByRole("button", { name: "分栏" }));
  const right = screen.getByRole("tablist", { name: "右栏内容" }).parentElement!;
  vi.spyOn(right, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 0, 500, 42));
  vi.spyOn(screen.getByRole("tab", { name: "甲" }).parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 0, 100, 32));
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
  expect(screen.getByRole("tab", { name: "运行会话" }).parentElement).toHaveAttribute("data-running", "true");
  expect(screen.getByRole("tab", { name: "空闲会话" }).parentElement).not.toHaveAttribute("data-running");
  expect(screen.getByRole("tab", { name: "计划.md" })).toHaveAttribute("title", expect.stringContaining("Markdown"));
  act(() => useAgentPanelStore.getState().setSessionRuns("/workspace", 7, {}));
  expect(screen.getByRole("tab", { name: "运行会话" }).parentElement).not.toHaveAttribute("data-running");
  expect(useAgentPanelStore.getState().sessionsByProject[dshProjectRunKey("/workspace", 7)]).toBeUndefined();
});
it("reveals the selected tab after route selection and keyboard navigation", () => {
  const a = open(1, "甲"); open(2, "乙"); render(<Harness />);
  const viewport = screen.getByRole("tablist").parentElement!;
  Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 1000 });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 36));
  vi.spyOn(screen.getByRole("tab", { name: "甲" }).parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 0, 120, 30));
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
  vi.spyOn(screen.getByRole("tab", { name: "甲" }).parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 32));
  vi.spyOn(screen.getByRole("tab", { name: "乙" }).parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 100, 32));
  pointer("pointerDown", screen.getByRole("tab", { name: "乙" }), { clientX: 150, clientY: 15 });
  pointer("pointerMove", window, { clientX: 20, clientY: 15 });
  expect(screen.getByRole("tab", { name: "甲" }).parentElement!).toHaveAttribute("data-drop", "before");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("tab", { name: "甲" }).parentElement!).not.toHaveAttribute("data-drop");
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
  vi.spyOn(screen.getByRole("tab", { name: "甲" }).parentElement!, "getBoundingClientRect").mockImplementation(() => new DOMRect(-viewport.scrollLeft, 0, 100, 32));
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
