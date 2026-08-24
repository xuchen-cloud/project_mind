import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMotionPresence } from "./useMotionPresence";

describe("useMotionPresence", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps closing content mounted until the transition completes", () => {
    vi.useFakeTimers();
    const commitExit = vi.fn((update: () => void) => update());
    const { result, rerender } = renderHook(
      ({ visible }) => useMotionPresence(visible, { commitExit }),
      { initialProps: { visible: true } },
    );

    rerender({ visible: false });
    expect(result.current).toMatchObject({ mounted: true, state: "closing" });

    act(() => vi.advanceTimersByTime(159));
    expect(result.current.mounted).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(commitExit).toHaveBeenCalledOnce();
    expect(result.current.mounted).toBe(false);
  });

  it("finishes an exit from the animated element transition and keeps the timer as fallback", () => {
    vi.useFakeTimers();
    const commitExit = vi.fn((update: () => void) => update());
    const { result, rerender } = renderHook(
      ({ visible }) => useMotionPresence(visible, { commitExit }),
      { initialProps: { visible: true } },
    );
    const element = document.createElement("div");

    rerender({ visible: false });
    act(() => {
      result.current.onTransitionEnd({
        target: element,
        currentTarget: element,
      } as never);
    });

    expect(commitExit).toHaveBeenCalledOnce();
    expect(result.current.mounted).toBe(false);
    act(() => vi.advanceTimersByTime(160));
    expect(commitExit).toHaveBeenCalledOnce();
  });

  it("cancels the pending exit when visibility reverses", () => {
    vi.useFakeTimers();
    const commitExit = vi.fn((update: () => void) => update());
    const { result, rerender } = renderHook(
      ({ visible }) => useMotionPresence(visible, { commitExit }),
      { initialProps: { visible: true } },
    );

    rerender({ visible: false });
    rerender({ visible: true });
    act(() => vi.advanceTimersByTime(160));

    expect(commitExit).not.toHaveBeenCalled();
    expect(result.current.mounted).toBe(true);
  });
});
