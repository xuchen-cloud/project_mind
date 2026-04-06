import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TodoInlineProgressEditor } from "./TodoInlineProgressEditor";

describe("TodoInlineProgressEditor", () => {
  it("shows an inline placeholder and saves a new progress when empty", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <TodoInlineProgressEditor latestProgress={null} editable onSave={onSave} onError={vi.fn()} />,
    );

    expect(screen.queryByText(/\+\s*进展/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "点击添加进展..." }));
    expect(screen.getByRole("textbox").tagName).toBe("TEXTAREA");

    await user.type(screen.getByPlaceholderText("@0315 已与财务确认方案"), "@0315 已确认方案");
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith({
      content: "已确认方案",
      progressDate: expect.stringMatching(/^\d{4}-03-15$/u),
    });
  });

  it("uses the existing progress content as the trigger surface", async () => {
    const user = userEvent.setup();

    render(
      <TodoInlineProgressEditor
        latestProgress={{ content: "完成问题答复", progressDate: "2026-04-06" }}
        editable
        onSave={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /完成问题答复\s*4月6日/u }));

    expect(screen.getByPlaceholderText("@0315 已与财务确认方案")).toBeInTheDocument();
  });

  it("normalizes pasted line breaks before saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<TodoInlineProgressEditor latestProgress={null} editable onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "点击添加进展..." }));

    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "@0315 已确认\n方案" } });

    expect(screen.getByRole("textbox")).toHaveValue("@0315 已确认 方案");

    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith({
      content: "已确认 方案",
      progressDate: expect.stringMatching(/^\d{4}-03-15$/u),
    });
  });
});
