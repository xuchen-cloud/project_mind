import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOTION_DURATION_MS } from "../ui/motion";
import { useFocusTarget, useScrollPositionRestoration } from "./useUtilityHooks";

function FocusTargetHarness({
  enabled,
  scope = "project",
}: {
  enabled: boolean;
  scope?: "project" | "workspace";
}) {
  useFocusTarget("record-7", [], { enabled, refocusOnEnable: false });

  return (
    <div data-testid={`${scope}-overview-focus-scroll`}>
      <div id="record-7">目标记录</div>
    </div>
  );
}

function ScrollRestorationHarness({ routeKey }: { routeKey: string }) {
  const { scrollRef, hasSavedPosition } = useScrollPositionRestoration(routeKey);
  return (
    <div
      ref={scrollRef}
      data-testid="focus-scroll"
      data-has-saved-position={hasSavedPosition}
    />
  );
}

describe("useFocusTarget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["project", "workspace"] as const)(
    "positions a %s Record once and clears its focus cue after the deliberate motion duration",
    (scope) => {
      vi.useFakeTimers();
      const scrollTo = vi.fn();
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: scrollTo,
      });

      render(<FocusTargetHarness enabled scope={scope} />);

      const record = document.getElementById("record-7");
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
      expect(record).toHaveClass("is-focused");

      act(() => vi.advanceTimersByTime(MOTION_DURATION_MS.deliberate));

      expect(record).not.toHaveClass("is-focused");
    },
  );

  it("positions a Record without smooth movement when reduced motion is preferred", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );

    render(<FocusTargetHarness enabled />);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("does not reposition an already focused card when a cached page becomes visible again", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    const view = render(<FocusTargetHarness enabled />);
    expect(scrollTo).toHaveBeenCalled();

    view.rerender(<FocusTargetHarness enabled={false} />);
    scrollTo.mockClear();
    view.rerender(<FocusTargetHarness enabled />);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("restores a separate scroll position for each focus page", () => {
    const view = render(<ScrollRestorationHarness routeKey="project-record:1:7" />);
    const scroll = view.getByTestId("focus-scroll");
    scroll.scrollTop = 137;

    view.rerender(<ScrollRestorationHarness routeKey="project-record:1:8" />);
    expect(scroll.scrollTop).toBe(0);
    scroll.scrollTop = 42;

    view.rerender(<ScrollRestorationHarness routeKey="project-record:1:7" />);
    expect(scroll.scrollTop).toBe(137);
    expect(scroll).toHaveAttribute("data-has-saved-position", "true");
  });

  it("waits for the editor content to finish laying out before restoring", () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const flushFrames = () => {
      const pending = Array.from(frames.values());
      frames.clear();
      for (const callback of pending) callback(0);
    };

    const view = render(<ScrollRestorationHarness routeKey="delayed-record:1" />);
    const scroll = view.getByTestId("focus-scroll");
    let maxScrollTop = 500;
    let currentScrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 100 + maxScrollTop },
      scrollTop: {
        configurable: true,
        get: () => currentScrollTop,
        set: (value: number) => {
          currentScrollTop = Math.max(0, Math.min(value, maxScrollTop));
        },
      },
    });

    scroll.scrollTop = 215;
    view.rerender(<ScrollRestorationHarness routeKey="delayed-record:2" />);

    maxScrollTop = 0;
    view.rerender(<ScrollRestorationHarness routeKey="delayed-record:1" />);
    act(flushFrames);
    expect(scroll.scrollTop).toBe(0);

    maxScrollTop = 500;
    act(() => {
      for (const callback of resizeCallbacks) {
        callback([], {} as ResizeObserver);
      }
      flushFrames();
    });

    expect(scroll.scrollTop).toBe(215);
  });
});
