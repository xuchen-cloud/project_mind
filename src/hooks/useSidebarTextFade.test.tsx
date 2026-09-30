import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSidebarTextFade } from "./useSidebarTextFade";

function Harness() {
  useSidebarTextFade();
  return <><aside><span className="truncate">完整的项目名称</span><button>操作</button></aside><main><span className="truncate">正文</span></main></>;
}
afterEach(() => vi.unstubAllGlobals());
it("fades overflowing sidebar text and clears the fade after widening without masking controls or main content", () => {
  let resized: ResizeObserverCallback = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  render(<Harness />);
  const label = screen.getByText("完整的项目名称");
  let width = 80;
  Object.defineProperties(label, {
    clientWidth: { get: () => width },
    scrollWidth: { get: () => 160 },
  });
  const resize = () => act(() => resized([{ target: label } as ResizeObserverEntry], {} as ResizeObserver));
  resize();
  expect(label).toHaveAttribute("data-text-overflow");
  expect(label).toHaveAttribute("title", "完整的项目名称");
  expect(screen.getByRole("button")).not.toHaveAttribute("data-sidebar-text");
  expect(screen.getByText("正文")).not.toHaveAttribute("data-sidebar-text");
  width = 200;
  resize();
  expect(label).not.toHaveAttribute("data-text-overflow");
});
