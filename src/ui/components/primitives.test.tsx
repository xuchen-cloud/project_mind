import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Search } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Button,
  Dialog,
  IconButton,
  PopoverPanel,
  SearchField,
  StatusBadge,
  TextField,
  ToolbarButton,
} from "./index";

describe("ui primitives", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps popover motion opt-in", () => {
    const { rerender } = render(<PopoverPanel data-testid="panel" />);
    expect(screen.getByTestId("panel")).not.toHaveAttribute("data-motion");

    rerender(<PopoverPanel data-testid="panel" motion="trigger" motionOrigin="top left" />);
    expect(screen.getByTestId("panel")).toHaveAttribute("data-motion", "trigger");
    expect(screen.getByTestId("panel")).toHaveStyle({ transformOrigin: "top left" });
  });

  it("renders button variants with icons", () => {
    render(
      <Button variant="primary" leadingIcon={<Search size={14} />}>
        Search
      </Button>,
    );

    const button = screen.getByRole("button", { name: /search/i });
    expect(button).toHaveClass("bg-text");
  });

  it("gives every shared pressable the same restrained press feedback", () => {
    render(
      <div>
        <Button>Button</Button>
        <IconButton aria-label="icon button">
          <Search size={14} />
        </IconButton>
        <ToolbarButton aria-label="toolbar button">
          <Search size={14} />
        </ToolbarButton>
      </div>,
    );

    for (const name of ["Button", "icon button", "toolbar button"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "active:scale-[0.97]",
        "motion-reduce:transform-none",
        "duration-[var(--duration-fast)]",
      );
    }
  });

  it("renders text and search fields", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <TextField aria-label="title" placeholder="Title" />
        <SearchField aria-label="search" placeholder="Search here" />
      </div>,
    );

    await user.type(screen.getByLabelText("title"), "Alpha");
    await user.type(screen.getByLabelText("search"), "todo");

    expect(screen.getByLabelText("title")).toHaveValue("Alpha");
    expect(screen.getByLabelText("search")).toHaveValue("todo");
  });

  it("renders icon buttons, dialogs, badges, and toolbar buttons", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <div>
        <IconButton aria-label="settings">
          <Search size={14} />
        </IconButton>
        <StatusBadge tone="warning">warning</StatusBadge>
        <ToolbarButton aria-label="toolbar" active>
          <Search size={14} />
        </ToolbarButton>
        <Dialog open title="Dialog Title" description="Dialog copy" onClose={onClose}>
          <div>Dialog body</div>
        </Dialog>
      </div>,
    );

    expect(screen.getByText("Dialog body")).toBeInTheDocument();
    expect(screen.getByText("warning")).toHaveClass("text-warning");
    expect(screen.getByLabelText("toolbar")).toHaveClass("text-accent");

    await user.click(screen.getByLabelText("关闭对话框"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("supports raising a dialog above another modal layer", () => {
    render(
      <Dialog open title="Nested Dialog" onClose={() => undefined} layerClassName="z-[60]">
        <div>Nested dialog body</div>
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Nested Dialog" }).parentElement).toHaveClass(
      "z-[60]",
    );
  });

  it("keeps only the closing dialog visual for 160ms", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <Dialog open title="Closing Dialog" onClose={vi.fn()}><p>Body</p></Dialog>,
    );

    rerender(<Dialog open={false} title="Closing Dialog" onClose={vi.fn()}><p>Body</p></Dialog>);

    const portal = document.querySelector("[data-dialog-portal]") as HTMLElement;
    const backdrop = portal.firstElementChild as HTMLElement;
    expect(screen.queryByRole("dialog", { name: "Closing Dialog" })).not.toBeInTheDocument();
    expect(backdrop).toHaveAttribute("data-state", "closing");
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).toHaveAttribute("inert");

    act(() => vi.advanceTimersByTime(160));
    expect(document.querySelector("[data-dialog-portal]")).not.toBeInTheDocument();
  });

  it("cancels Dialog exit when it reopens without creating a second portal", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open title="Reopening Dialog" onClose={onClose}><p>Body</p></Dialog>,
    );
    const portal = document.querySelector("[data-dialog-portal]");

    rerender(
      <Dialog open={false} title="Reopening Dialog" onClose={onClose}><p>Body</p></Dialog>,
    );
    rerender(
      <Dialog open title="Reopening Dialog" onClose={onClose}><p>Body</p></Dialog>,
    );
    act(() => vi.advanceTimersByTime(160));

    expect(screen.getByRole("dialog", { name: "Reopening Dialog" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-dialog-portal]")).toHaveLength(1);
    expect(document.querySelector("[data-dialog-portal]")).toBe(portal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus inside an open dialog and restores its trigger on close", async () => {
    const user = userEvent.setup();

    function DialogHarness() {
      const [open, setOpen] = useState(false);

      return (
        <main>
          <button type="button" onClick={() => setOpen(true)}>打开编辑</button>
          <a href="#outside">背景链接</a>
          <Dialog open={open} title="编辑 Project" onClose={() => setOpen(false)}>
            <label>
              Project 名称
              <input />
            </label>
            <button type="button">保存</button>
          </Dialog>
        </main>
      );
    }

    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开编辑" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "编辑 Project" });
    expect(within(dialog).getByRole("button", { name: "关闭对话框" })).toHaveFocus();
    expect(trigger.closest("main")?.parentElement).toHaveAttribute("inert");

    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "保存" })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "关闭对话框" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "编辑 Project" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger.closest("main")?.parentElement).not.toHaveAttribute("inert");
  });
});
