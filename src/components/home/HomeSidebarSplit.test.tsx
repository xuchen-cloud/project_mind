import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { HomeSidebarSplit } from "./HomeSidebarSplit";

beforeEach(() => localStorage.clear());

it("resizes with keyboard, clamps both ends, and restores the saved proportion", () => {
  const props = { storageKey: "split-test", upper: <div>项目</div>, lower: <div>标签</div> };
  const view = render(<HomeSidebarSplit {...props} />);
  const divider = screen.getByRole("separator");
  fireEvent.keyDown(divider, { key: "ArrowDown" });
  expect(divider).toHaveAttribute("aria-valuenow", "52");
  fireEvent.keyDown(divider, { key: "End" });
  fireEvent.keyDown(divider, { key: "ArrowDown" });
  expect(divider).toHaveAttribute("aria-valuenow", "80");
  fireEvent.keyDown(divider, { key: "Home" });
  fireEvent.keyDown(divider, { key: "ArrowUp" });
  expect(divider).toHaveAttribute("aria-valuenow", "20");
  view.unmount();
  render(<HomeSidebarSplit {...props} />);
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "20");
});
