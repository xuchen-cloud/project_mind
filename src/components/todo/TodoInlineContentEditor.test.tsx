import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TodoInlineContentEditor } from "./TodoInlineContentEditor";

describe("TodoInlineContentEditor", () => {
  it("uses a wrapping textarea and saves without manual line breaks", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <TodoInlineContentEditor
        value="和税务对齐相关方案"
        editable
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "和税务对齐相关方案" }));

    const textbox = screen.getByRole("textbox");
    expect(textbox.tagName).toBe("TEXTAREA");

    fireEvent.change(textbox, { target: { value: "第一段\n第二段" } });
    expect(screen.getByRole("textbox")).toHaveValue("第一段 第二段");

    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("第一段 第二段");
  });
});
