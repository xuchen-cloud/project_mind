import { act, renderHook } from "@testing-library/react";
import { startTransition, StrictMode, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFileDropTarget } from "./useFileDropTarget";

const file = { id: 1, name: "Draft", revision: 3 };

describe("useFileDropTarget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("requires 750ms of hovering before offering and consuming a File target", () => {
    const { result } = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }));
    expect(result.current.readyTarget).toBeNull();
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(749));
    expect(result.current.readyTarget).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.readyTarget).toEqual(file);
    let consumed: typeof file | null = null;
    act(() => { consumed = result.current.consume(); });
    expect(consumed).toEqual(file);
    expect(result.current.readyTarget).toBeNull();
    expect(result.current.consume()).toBeNull();
  });
  it("never consumes the same committed target twice in one event", () => {
    const { result } = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }));
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(750));
    act(() => {
      expect(result.current.consume()).toEqual(file);
      expect(result.current.consume()).toBeNull();
    });
  });

  it("keeps the first File baseline and dwell time across repeated hover events", () => {
    const { result } = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }));
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(500));
    act(() => result.current.hover({ ...file, name: "Changed", revision: 4 }));
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.readyTarget).toEqual(file);
    act(() => result.current.hover({ ...file, revision: 5 }));
    act(() => expect(result.current.consume()).toEqual(file));
  });

  it("cancels a pending hover and a visible prompt when its scope changes", () => {
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useFileDropTarget<typeof file>({ enabled: true, scopeKey }),
      { initialProps: { scopeKey: "project:1" } },
    );
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(500));
    rerender({ scopeKey: "project:2" });
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.readyTarget).toBeNull();
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.readyTarget).toEqual(file);
    rerender({ scopeKey: "workspace" });
    expect(result.current.readyTarget).toBeNull();
    expect(result.current.consume()).toBeNull();
  });

  it("does not consume when the timer fires before React commits the prompt", () => {
    const { result } = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }));
    act(() => result.current.hover(file));
    act(() => {
      vi.advanceTimersByTime(750);
      expect(result.current.readyTarget).toBeNull();
      expect(result.current.consume()).toBeNull();
    });
    expect(result.current.readyTarget).toBeNull();
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.consume()).toBeNull();
  });

  it("cancels a quick drop instead of offering a delayed update afterward", () => {
    const { result } = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }));
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(749));
    act(() => expect(result.current.consume()).toBeNull());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.readyTarget).toBeNull();
  });

  it("starts a full dwell on a different File and immediately revokes the old prompt", () => {
    const otherFile = { id: 2, name: "Other", revision: 1 };
    const { result } = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1", delayMs: 900 }));
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(700));
    act(() => result.current.hover(otherFile));
    act(() => vi.advanceTimersByTime(899));
    expect(result.current.readyTarget).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.readyTarget).toEqual(otherFile);
    act(() => {
      result.current.hover(file);
      expect(result.current.consume()).toBeNull();
    });
    expect(result.current.readyTarget).toBeNull();
  });

  it.each(["leave", "reset", "blank"] as const)("clears both pending and committed targets on %s, requiring a fresh dwell", (action) => {
    const { result } = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }));
    const exit = () => action === "blank" ? result.current.hover(null) : result.current[action]();
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(500));
    act(exit);
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.readyTarget).toBeNull();
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(749));
    expect(result.current.readyTarget).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.readyTarget).toEqual(file);
    act(() => {
      exit();
      expect(result.current.consume()).toBeNull();
    });
    expect(result.current.readyTarget).toBeNull();
  });

  it("cancels pending and ready targets when disabled and starts fresh when enabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useFileDropTarget<typeof file>({ enabled, scopeKey: "project:1" }),
      { initialProps: { enabled: true } },
    );
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(500));
    rerender({ enabled: false });
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.readyTarget).toBeNull();
    expect(result.current.consume()).toBeNull();
    rerender({ enabled: true });
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.readyTarget).toBeNull();
    act(() => result.current.hover(file));
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.readyTarget).toEqual(file);
    rerender({ enabled: false });
    expect(result.current.readyTarget).toBeNull();
    expect(result.current.consume()).toBeNull();
  });

  it("releases pending timers and committed targets on unmount under StrictMode", () => {
    const pending = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }), { wrapper: StrictMode });
    act(() => pending.result.current.hover(file));
    const before = vi.getTimerCount();
    expect(before).toBeGreaterThan(0);
    pending.unmount();
    expect(vi.getTimerCount()).toBe(before - 1);

    const ready = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }), { wrapper: StrictMode });
    act(() => ready.result.current.hover(file));
    act(() => vi.advanceTimersByTime(750));
    expect(ready.result.current.readyTarget).toEqual(file);
    const consume = ready.result.current.consume;
    ready.unmount();
    expect(consume()).toBeNull();
  });

  it("cannot consume a prompt from a suspended React render", () => {
    const pending = new Promise<void>(() => {});
    const { result } = renderHook(() => {
      const target = useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" });
      if (target.readyTarget) throw pending;
      return target;
    }, { wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
    act(() => result.current.hover(file));
    act(() => startTransition(() => { vi.advanceTimersByTime(750); }));
    expect(result.current.readyTarget).toBeNull();
    act(() => expect(result.current.consume()).toBeNull());
    expect(result.current.readyTarget).toBeNull();
  });

  it("captures the initial File fields even if the caller later mutates its object", () => {
    const mutableFile = { ...file };
    const { result } = renderHook(() => useFileDropTarget<typeof file>({ enabled: true, scopeKey: "project:1" }));
    act(() => result.current.hover(mutableFile));
    mutableFile.name = "Changed";
    mutableFile.revision = 4;
    act(() => vi.advanceTimersByTime(750));
    expect(result.current.readyTarget).toEqual(file);
    act(() => expect(result.current.consume()).toEqual(file));
  });
});
