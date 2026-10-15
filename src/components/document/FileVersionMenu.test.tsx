import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileVersionMenu, type FileVersionMenuProps } from "./FileVersionMenu";

const versions = [{ id: "three", versionNumber: 3, isCurrent: true }, { id: "two", versionNumber: 2 }];
const defaults: FileVersionMenuProps = { label: "文件版本", triggerLabel: "v3", versions, onSelect: vi.fn() };
function open() { fireEvent.click(screen.getByRole("button", { name: "文件版本" })); }

describe("FileVersionMenu", () => {
  it("opens a portal menu with exact trigger text and selected latest/fixed choices", async () => {
    const onSelect = vi.fn();
    const view = render(<FileVersionMenu {...defaults} includeLatest latestVersion={3} onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "文件版本" });
    expect(trigger.textContent).toBe("v3");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger.querySelector("svg")).not.toBeNull();
    open();
    const menu = screen.getByRole("menu", { name: "文件版本列表" });
    expect(menu.querySelector("svg")).toBeNull();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    expect(view.container).not.toContainElement(menu);
    expect(menu).toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: "v3（当前）" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "v2" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "v2" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(onSelect).toHaveBeenCalledWith(2);
    expect(trigger).toHaveFocus();
  });
});

it("navigates from the menu using arrows/Home/End and dismisses with focus restoration", () => {
  const onOpenChange = vi.fn();
  render(<FileVersionMenu {...defaults} selectedVersion={3} onHistory={vi.fn()} onOpenChange={onOpenChange} />);
  open();
  const menu = screen.getByRole("menu");
  const current = screen.getByRole("menuitemradio", { name: "v3" });
  expect(current).toHaveAttribute("aria-checked", "true");
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(current).toHaveFocus();
  fireEvent.keyDown(current, { key: "ArrowDown" });
  expect(screen.getByRole("menuitemradio", { name: "v2" })).toHaveFocus();
  fireEvent.keyDown(menu, { key: "End" });
  expect(screen.getByRole("menuitem", { name: "查看历史与比较" })).toHaveFocus();
  fireEvent.keyDown(menu, { key: "Home" });
  expect(current).toHaveFocus();
  fireEvent.keyDown(current, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "文件版本" })).toHaveFocus();
  expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  open();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("marks the sidebar trigger as interactive and keeps dated row names stable", () => {
  render(<FileVersionMenu {...defaults} variant="badge" selectedVersion={3} versions={[{ ...versions[0], createdAt: "2026-10-15T08:30:00Z" }]} />);
  const trigger = screen.getByRole("button", { name: "文件版本" });
  expect(trigger).toHaveAttribute("data-document-interactive", "true");
  expect(trigger.parentElement).toHaveAttribute("data-document-interactive", "true");
  open();
  const current = screen.getByRole("menuitemradio", { name: "v3" });
  expect(current).toHaveTextContent("（当前）");
  expect(current.querySelector("time")).toHaveAttribute("datetime", "2026-10-15T08:30:00Z");
});

it("awaits selection, prevents duplicate requests, and closes before history callback", async () => {
  let finish!: () => void;
  const onSelect = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const onHistory = vi.fn(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  render(<FileVersionMenu {...defaults} onSelect={onSelect} includeLatest onHistory={onHistory} />);
  open();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "当前版本" }));
  expect(onSelect).toHaveBeenCalledWith(undefined);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: "v2" })).toBeDisabled();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "v2" }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "查看历史与比较" }));
  expect(onHistory).toHaveBeenCalledOnce();
});

it("shows loading, empty and error states with retry only when explicitly provided", () => {
  const onRetry = vi.fn();
  const view = render(<FileVersionMenu {...defaults} versions={[]} loading />);
  open();
  expect(screen.getByRole("status")).toHaveTextContent("正在读取版本");
  view.rerender(<FileVersionMenu {...defaults} versions={[]} />);
  expect(screen.getByRole("status")).toHaveTextContent("暂无版本");
  view.rerender(<FileVersionMenu {...defaults} versions={[]} error="读取失败" />);
  expect(screen.getByRole("alert")).toHaveTextContent("读取失败");
  expect(screen.queryByRole("menuitem", { name: "重试" })).not.toBeInTheDocument();
  view.rerender(<FileVersionMenu {...defaults} versions={[]} error="读取失败" onRetry={onRetry} />);
  expect(onRetry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "重试" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it("preserves a failed selection in the menu with a visible error", async () => {
  render(<FileVersionMenu {...defaults} onSelect={async () => { throw new Error("读取版本失败"); }} />);
  open();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "v2" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("读取版本失败");
  expect(screen.getByRole("menuitemradio", { name: "v2" })).toBeEnabled();
});

it("closes when hidden or renamed and ignores selection completion from a previous opening", async () => {
  let finish!: () => void;
  const onSelect = () => new Promise<void>(resolve => { finish = resolve; });
  const view = render(<FileVersionMenu {...defaults} onSelect={onSelect} />);
  open();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "v2" }));
  view.rerender(<FileVersionMenu {...defaults} onSelect={onSelect} visible={false} />);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  view.rerender(<FileVersionMenu {...defaults} onSelect={onSelect} />);
  open();
  await act(async () => finish());
  expect(screen.getByRole("menu")).toBeInTheDocument();
  view.rerender(<FileVersionMenu {...defaults} label="其他文件版本" />);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("contains click propagation and exposes continuous scroll edges", () => {
  const parentClick = vi.fn();
  render(<div onClick={parentClick}><FileVersionMenu {...defaults} /></div>);
  open();
  const list = screen.getByRole("region", { name: "文件版本选项" });
  Object.defineProperties(list, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 300 } });
  fireEvent.scroll(list, { target: { scrollTop: 0 } });
  expect(list).not.toHaveAttribute("data-overflow-top");
  expect(list).toHaveAttribute("data-overflow-bottom");
  fireEvent.scroll(list, { target: { scrollTop: 168 } });
  expect(list.parentElement!.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
  fireEvent.scroll(list, { target: { scrollTop: 200 } });
  expect(list).not.toHaveAttribute("data-overflow-bottom");
  fireEvent.scroll(list, { target: { scrollTop: 168 } });
  expect(list.parentElement!.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
  fireEvent.click(list);
  expect(parentClick).not.toHaveBeenCalled();
});

it("opens above a low trigger and clamps horizontal position and available height", () => {
  render(<FileVersionMenu {...defaults} />);
  const trigger = screen.getByRole("button", { name: "文件版本" });
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: window.innerHeight - 40, bottom: window.innerHeight - 10, left: 0, right: 50, width: 50, height: 30, x: 0, y: window.innerHeight - 40, toJSON() {} });
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
  open();
  const menu = screen.getByRole("menu");
  expect(Number.parseFloat(menu.style.top)).toBeLessThan(window.innerHeight - 40);
  expect(Number.parseFloat(menu.style.left)).toBe(12);
  expect(Number.parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 58);
  scrollHeight.mockRestore();
});
