import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelListLayoutMotion, commitListLayoutChange } from "./listLayoutMotion";

function rect(top: number): DOMRect {
  return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON: () => ({}) };
}

describe("commitListLayoutChange", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("moves affected siblings with a transform-only FLIP", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const container = document.createElement("div");
    const item = document.createElement("div");
    item.dataset.layoutMotionId = "second";
    container.append(item);
    document.body.append(container);
    let top = 100;
    vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => rect(top));

    commitListLayoutChange(container, () => {
      top = 180;
    });
    frames.shift()?.(0);

    expect(item.dataset.layoutMotion).toBe("inverted");
    expect(item.style.getPropertyValue("--list-layout-delta-y")).toBe("-80px");

    frames.shift()?.(16);
    expect(item.dataset.layoutMotion).toBe("playing");
    expect(item.style.getPropertyValue("--list-layout-delta-y")).toBe("0px");

    vi.advanceTimersByTime(160);
    expect(item.dataset.layoutMotion).toBeUndefined();
  });

  it("commits layout immediately without frames for reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    const update = vi.fn();

    commitListLayoutChange(document.createElement("div"), update);

    expect(update).toHaveBeenCalledOnce();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("can cancel queued work on unmount", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const container = document.createElement("div");

    commitListLayoutChange(container, vi.fn());
    cancelListLayoutMotion(container);

    expect(cancelFrame).toHaveBeenCalled();
  });
});
