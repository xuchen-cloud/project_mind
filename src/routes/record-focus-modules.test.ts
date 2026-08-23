import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/project/ProjectNoteFocusPage", () => ({ ProjectNoteFocusPage: vi.fn() }));
vi.mock("../components/workspace/WorkspaceRecordFocusPage", () => ({ WorkspaceRecordFocusPage: vi.fn() }));

import { scheduleRecordFocusPageModulesPreload } from "./record-focus-modules";

describe("scheduleRecordFocusPageModulesPreload", () => {
  afterEach(() => vi.useRealTimers());

  it("uses idle scheduling with a timeout and cancels on cleanup", () => {
    const callback = vi.fn();
    const requestIdleCallback = vi.fn((next: IdleRequestCallback) => { callback.mockImplementation(next); return 42; });
    const cancelIdleCallback = vi.fn();
    const cleanup = scheduleRecordFocusPageModulesPreload({ requestIdleCallback, cancelIdleCallback } as unknown as Window);

    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1500 });
    cleanup();
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
  });

  it("falls back to a zero-delay timer and clears it on cleanup", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const cleanup = scheduleRecordFocusPageModulesPreload(window);

    expect(vi.getTimerCount()).toBe(1);
    cleanup();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
