import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPortal } from "react-dom";
import { beforeEach, expect, it } from "vitest";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import { RightSidebar } from "./RightSidebar";

function Fixture() {
  const { todoRailCollapsed, toggleTodoRailCollapsed, todoRailMode, setTodoRailMode } = useUiStore();
  return <>
    <button data-right-sidebar-toggle aria-expanded={!todoRailCollapsed} onClick={toggleTodoRailCollapsed}>切换右栏</button>
    <button>正文操作</button>
    <RightSidebar>
      <input aria-label="待办草稿" />
      <button onClick={() => setTodoRailMode(todoRailMode === "floating" ? "pinned" : "floating")}>固定切换</button>
      {createPortal(<button>右栏菜单</button>, document.body)}
    </RightSidebar>
  </>;
}

beforeEach(() => useUiStore.setState({ ...createUiStoreState(), todoRailCollapsed: false }));

it("dismisses floating content on outside click and preserves drafts when reopened", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.type(screen.getByRole("textbox", { name: "待办草稿" }), "尚未提交的内容");
  await user.click(screen.getByRole("button", { name: "正文操作" }));
  expect(screen.getByRole("button", { name: "切换右栏" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByLabelText("右侧栏")).toHaveAttribute("inert");
  await user.click(screen.getByRole("button", { name: "切换右栏" }));
  expect(screen.getByRole("textbox", { name: "待办草稿" })).toHaveValue("尚未提交的内容");
});

it("keeps internal controls, portalled menus and the toggle inside the interaction boundary", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByRole("button", { name: "右栏菜单" }));
  expect(useUiStore.getState().todoRailCollapsed).toBe(false);
  await user.click(screen.getByRole("button", { name: "切换右栏" }));
  expect(useUiStore.getState().todoRailCollapsed).toBe(true);
  await user.click(screen.getByRole("button", { name: "切换右栏" }));
  expect(useUiStore.getState().todoRailCollapsed).toBe(false);
});

it("dismisses when keyboard focus moves to the page, but pinned content stays open", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  act(() => screen.getByRole("textbox", { name: "待办草稿" }).focus());
  act(() => screen.getByRole("button", { name: "正文操作" }).focus());
  expect(useUiStore.getState().todoRailCollapsed).toBe(true);
  await user.click(screen.getByRole("button", { name: "切换右栏" }));
  await user.click(screen.getByRole("button", { name: "固定切换" }));
  expect(screen.getByLabelText("右侧栏")).toHaveAttribute("data-mode", "pinned");
  await user.click(screen.getByRole("button", { name: "正文操作" }));
  expect(useUiStore.getState().todoRailCollapsed).toBe(false);
  await user.click(screen.getByRole("button", { name: "固定切换" }));
  await user.click(screen.getByRole("button", { name: "正文操作" }));
  expect(useUiStore.getState().todoRailCollapsed).toBe(true);
});

it("closes floating content on Escape and returns focus to the toggle", () => {
  render(<Fixture />);
  act(() => within(screen.getByLabelText("右侧栏")).getByRole("textbox").focus());
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(useUiStore.getState().todoRailCollapsed).toBe(true);
  expect(screen.getByRole("button", { name: "切换右栏" })).toHaveFocus();
});

it("restores the standalone window toggle after Escape", () => {
  render(<RightSidebar showToggle><input aria-label="独立窗口待办" /></RightSidebar>);
  act(() => screen.getByRole("textbox").focus());
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.getByRole("button", { name: "切换右侧栏" })).toHaveFocus();
});

it("keeps width adjustment available across floating and pinned modes", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  const resize = screen.getByRole("separator", { name: "调整 Todo Rail 宽度" });
  resize.focus();
  await user.keyboard("{ArrowLeft}");
  expect(useUiStore.getState().todoRailWidthPx).toBe(288);
  await user.click(screen.getByRole("button", { name: "固定切换" }));
  resize.focus();
  await user.keyboard("{ArrowLeft}");
  expect(useUiStore.getState().todoRailWidthPx).toBe(296);
});
