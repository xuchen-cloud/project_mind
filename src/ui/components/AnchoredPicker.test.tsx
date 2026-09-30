import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnchoredPicker } from "./AnchoredPicker";

afterEach(() => vi.restoreAllMocks());
it("escapes clipping, flips above the bottom edge, and follows scroll and resize", () => {
  const anchor = document.createElement("input");
  document.body.append(anchor);
  const anchorRef = createRef<HTMLElement>();
  anchorRef.current = anchor;
  let bottom = window.innerHeight - 12;
  vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => ({
    left: window.innerWidth - 30, top: bottom - 24, bottom, right: window.innerWidth - 10,
    width: 20, height: 24, x: 0, y: 0, toJSON() {},
  }));
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
  const { container, unmount } = render(<div style={{ overflow: "clip" }}>
    <AnchoredPicker anchorRef={anchorRef}><button>推荐内容</button></AnchoredPicker>
  </div>);
  const panel = screen.getByRole("button").parentElement!;
  expect(container.contains(panel)).toBe(false);
  expect(panel.style.top).toBe(`${bottom - 24 - 6 - 100}px`);
  expect(panel.style.left).toBe(`${window.innerWidth - 160 - 8}px`);
  bottom = 100;
  act(() => window.dispatchEvent(new Event("scroll")));
  expect(panel.style.top).toBe("106px");
  act(() => window.dispatchEvent(new Event("resize")));
  expect(panel.style.maxHeight).toBe(`${window.innerHeight - 114}px`);
  unmount();
  expect(panel).not.toBeInTheDocument();
  anchor.remove();
});
