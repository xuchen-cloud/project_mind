import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MoveSelectionToRecordCard, type MoveSelectionRecordOption } from "./MoveSelectionToRecordCard";

const records: MoveSelectionRecordOption[] = [
  {
    id: 1,
    title: "发布记录",
    contentMarkdown: "准备发布",
    updatedAt: "2026-08-24T08:00:00.000Z",
  },
];

describe("MoveSelectionToRecordCard", () => {
  afterEach(() => vi.useRealTimers());

  it("uses Dialog semantics, focuses search, and restores focus after Escape", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <main>
          <button type="button" onClick={() => setOpen(true)}>移动选区</button>
          <MoveSelectionToRecordCard
            records={records}
            open={open}
            onClose={() => setOpen(false)}
            onSelectRecord={vi.fn()}
            onCreateRecord={vi.fn()}
          />
        </main>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "移动选区" });
    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: "移动到记录" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索记录，或输入标题创建")).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "移动到记录" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.querySelector("[data-dialog-portal] > [data-state='closing']"))
      .toBeInTheDocument();
  });

  it("closes from the backdrop and completes visual presence from transitionend", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <main>
          <button type="button" onClick={() => setOpen(true)}>打开移动</button>
          <MoveSelectionToRecordCard
            records={records}
            open={open}
            onClose={() => setOpen(false)}
            onSelectRecord={vi.fn()}
            onCreateRecord={vi.fn()}
          />
        </main>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "打开移动" }));
    const backdrop = screen.getByRole("dialog", { name: "移动到记录" }).parentElement!;
    fireEvent.mouseDown(backdrop);

    expect(backdrop).toHaveAttribute("data-state", "closing");
    fireEvent.transitionEnd(backdrop);
    await waitFor(() =>
      expect(document.querySelector("[data-dialog-portal]")).not.toBeInTheDocument(),
    );
  });

  it("prevents duplicate record actions while an action is pending", () => {
    let resolveAction!: () => void;
    const onSelectRecord = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveAction = resolve;
      }),
    );

    render(
      <MoveSelectionToRecordCard
        records={records}
        open
        onClose={vi.fn()}
        onSelectRecord={onSelectRecord}
        onCreateRecord={vi.fn()}
      />,
    );

    const recordButton = screen.getByRole("button", { name: /发布记录/u });
    fireEvent.click(recordButton);
    fireEvent.click(recordButton);

    expect(onSelectRecord).toHaveBeenCalledOnce();
    expect(recordButton).toBeDisabled();
    act(() => resolveAction());
  });
});
