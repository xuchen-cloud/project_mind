import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  fireEvent.click(screen.getByRole("button", { name: "乙的操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "移动到左栏" }));
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
