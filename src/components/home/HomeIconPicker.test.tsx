import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HomeIconPicker } from "./HomeIconPicker";

it("searches Chinese labels, categories and icon names without losing selection", () => {
  const onChange = vi.fn();
  render(<HomeIconPicker value="Target" onChange={onChange} />);
  expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(63);
  const search = screen.getByRole("textbox", { name: "搜索项目图标" });
  fireEvent.change(search, { target: { value: "学习" } });
  expect(screen.getByRole("button", { name: "阅读" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "代码" })).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "rocket" } });
  fireEvent.click(screen.getByRole("button", { name: "发布" }));
  expect(onChange).toHaveBeenCalledWith("Rocket");
  fireEvent.change(search, { target: { value: "not-an-icon" } });
  expect(screen.getByText("没有匹配的图标，试试其他关键词")).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "目标" })).toHaveAttribute("aria-pressed", "true");
});
