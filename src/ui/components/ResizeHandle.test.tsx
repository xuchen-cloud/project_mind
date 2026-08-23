import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResizeHandle } from "./ResizeHandle";

describe("ResizeHandle", () => {
  it.each([
    ["right", "right"],
    ["left", "left"],
  ] as const)("exposes its %s panel edge so CSS can center the hit area on the divider", (edge, expected) => {
    render(
      <ResizeHandle
        label={`调整 ${edge} 边缘`}
        edge={edge}
        value={352}
        min={280}
        max={560}
        onChange={vi.fn()}
      />,
    );

    const handle = screen.getByRole("separator", { name: `调整 ${edge} 边缘` });
    expect(handle).toHaveAttribute("data-edge", expected);
    expect(handle).toHaveClass(edge === "right" ? "translate-x-1/2" : "-translate-x-1/2");
  });

  it("exposes separator values and supports keyboard steps", () => {
    const onChange = vi.fn();
    render(
      <ResizeHandle
        label="调整 Todo Rail 宽度"
        edge="left"
        value={352}
        min={280}
        max={560}
        onChange={onChange}
      />,
    );

    const handle = screen.getByRole("separator", { name: "调整 Todo Rail 宽度" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "352");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });

    expect(onChange.mock.calls.map(([next]) => next)).toEqual([360, 288, 280, 560]);
  });
});
