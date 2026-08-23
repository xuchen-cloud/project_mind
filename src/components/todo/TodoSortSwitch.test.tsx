import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TodoSortSwitch } from "./TodoSortSwitch";

describe("TodoSortSwitch", () => {
  it("uses roving tabs and moves selection and focus with direction keys", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(<TodoSortSwitch value="time" onChange={onChange} />);
    const timeTab = screen.getByRole("tab", { name: "按时间" });
    const priorityTab = screen.getByRole("tab", { name: "按优先级" });

    expect(timeTab).toHaveAttribute("aria-selected", "true");
    expect(timeTab).toHaveAttribute("tabindex", "0");
    expect(priorityTab).toHaveAttribute("tabindex", "-1");

    timeTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("priority");

    rerender(<TodoSortSwitch value="priority" onChange={onChange} />);
    expect(screen.getByRole("tab", { name: "按优先级" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith("time");

    rerender(<TodoSortSwitch value="time" onChange={onChange} />);
    expect(screen.getByRole("tab", { name: "按时间" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("priority");
  });
});
