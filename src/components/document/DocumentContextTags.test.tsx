import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DocumentContextTags } from "./DocumentContextTags";

it("shows only selected hash chips and selects from portaled recommendations without dismissing the menu", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const outsidePointer = vi.fn();
  const selected = { id: 1, label: "已有标签", colorKey: "red" as const };
  const available = [selected, { id: 2, label: "待审核", colorKey: "blue" as const }].map(tag => ({ ...tag, usageCount: 0, createdAt: "", updatedAt: "" }));
  const { container } = render(<DocumentContextTags projectId={1} availableTags={available}
    tags={[selected]} loading={false} onChange={onChange} />);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByText("待审核")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移除标签 已有标签" }).textContent).toContain("#");
  await user.type(screen.getByRole("textbox", { name: "新增标签" }), "待");
  const recommendation = screen.getByRole("button", { name: "待审核" });
  expect(container.contains(recommendation)).toBe(false);
  expect(recommendation.querySelector(".recommendation-icon")?.textContent).toBe("#");
  window.addEventListener("pointerdown", outsidePointer);
  try {
    await user.click(recommendation);
    expect(onChange).toHaveBeenCalledWith([1, 2]);
    expect(outsidePointer).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("pointerdown", outsidePointer);
  }
  await user.click(screen.getByRole("button", { name: "移除标签 已有标签" }));
  expect(onChange).toHaveBeenLastCalledWith([]);
});
