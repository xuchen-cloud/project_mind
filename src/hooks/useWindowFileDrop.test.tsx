import { act } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

const tauriWindowMocks = vi.hoisted(() => {
  const handlers = new Set<(event: { payload: DragDropPayload }) => void | Promise<void>>();
  let registrationGate: Promise<void> | null = null;
  const unlisten = vi.fn();
  const install = async (handler: (event: { payload: DragDropPayload }) => void | Promise<void>) => {
    handlers.add(handler);
    await registrationGate;
    return vi.fn(() => { unlisten(); handlers.delete(handler); });
  };
  return {
    onDragDropEvent: vi.fn(install), unlisten,
    blockRegistration(gate: Promise<void>) { registrationGate = gate; },
    async emit(event: { payload: DragDropPayload }) {
      await Promise.all([...handlers].map(handler => handler(event)));
    },
    reset() {
      handlers.clear();
      registrationGate = null;
      unlisten.mockClear();
      this.onDragDropEvent.mockReset().mockImplementation(install);
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: tauriWindowMocks.onDragDropEvent,
  }),
}));

let useWindowFileDrop: typeof import("./useWindowFileDrop").useWindowFileDrop;

function Harness({
  enabled = true,
  onDrop,
  isPositionActive,
}: {
  enabled?: boolean;
  onDrop: (paths: string[]) => void | Promise<unknown>;
  isPositionActive?: (position: { x: number; y: number }) => boolean;
}) {
  const [hovering, setHovering] = useState(false);

  useWindowFileDrop({
    enabled,
    onDrop,
    onHoverChange: setHovering,
    isPositionActive,
  });

  return <div>{hovering ? "hovering" : "idle"}</div>;
}

describe("useWindowFileDrop", () => {
  const originalTauriInternals = (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

  beforeEach(async () => {
    // Each test represents a fresh webview/module lifetime.
    vi.resetModules();
    useWindowFileDrop = (await import("./useWindowFileDrop")).useWindowFileDrop;
    tauriWindowMocks.reset();
    (await import("../state/feedback-store")).useFeedbackStore.setState({ toasts: [] });
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
      },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalTauriInternals === undefined) {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      return;
    }

    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalTauriInternals;
  });

  it("subscribes to Tauri window drag-drop events and forwards dropped paths", async () => {
    const onDrop = vi.fn(async () => undefined);

    render(<Harness onDrop={onDrop} />);

    await waitFor(() => expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1));

    await act(async () => {
      await tauriWindowMocks.emit({
        payload: {
          type: "enter",
          paths: ["/tmp/project-atlas/inbox/brief.pdf"],
          position: { x: 12, y: 18 },
        },
      });
    });

    expect(screen.getByText("hovering")).toBeInTheDocument();

    await act(async () => {
      await tauriWindowMocks.emit({
        payload: {
          type: "drop",
          paths: ["/tmp/project-atlas/inbox/brief.pdf"],
          position: { x: 20, y: 28 },
        },
      });
    });

    expect(onDrop).toHaveBeenCalledWith(["/tmp/project-atlas/inbox/brief.pdf"], { x: 20, y: 28 });
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("keeps pending native registration across unmount and reuses it with the latest subscriber", async () => {
    let installed!: () => void;
    tauriWindowMocks.blockRegistration(new Promise<void>(resolve => { installed = resolve; }));
    const oldDrop = vi.fn();
    const oldView = render(<Harness onDrop={oldDrop} />);
    expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1);
    oldView.unmount();
    await act(async () => { installed(); });
    expect(tauriWindowMocks.unlisten).not.toHaveBeenCalled();
    const drop = { payload: { type: "drop" as const, paths: ["/tmp/latest.pdf"], position: { x: 1, y: 1 } } };
    await act(async () => { await tauriWindowMocks.emit(drop); });
    expect(oldDrop).not.toHaveBeenCalled();
    const firstDrop = vi.fn();
    const latestDrop = vi.fn();
    const view = render(<Harness onDrop={firstDrop} />);
    view.rerender(<Harness onDrop={latestDrop} />);
    expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1);
    await act(async () => { await tauriWindowMocks.emit(drop); });
    expect(latestDrop).toHaveBeenCalledWith(["/tmp/latest.pdf"], { x: 1, y: 1 });
    expect(firstDrop).not.toHaveBeenCalled();
    expect(oldDrop).not.toHaveBeenCalled();
    view.unmount();
    expect(tauriWindowMocks.unlisten).not.toHaveBeenCalled();
  });

  it("shares one native subscription in StrictMode and filters subscribers by enabled state and position", async () => {
    const leftDrop = vi.fn();
    const rightDrop = vi.fn();
    const left = render(<StrictMode><Harness onDrop={leftDrop} isPositionActive={({ x }) => x < 50} /></StrictMode>);
    const right = render(<Harness onDrop={rightDrop} isPositionActive={({ x }) => x >= 50} />);
    await act(async () => {});
    expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1);
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "enter", paths: ["/tmp/left.pdf"], position: { x: 10, y: 1 } } });
    });
    expect(left.container).toHaveTextContent("hovering");
    expect(right.container).toHaveTextContent("idle");
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/left.pdf"], position: { x: 10, y: 1 } } });
    });
    expect(leftDrop).toHaveBeenCalledTimes(1);
    expect(rightDrop).not.toHaveBeenCalled();
    left.rerender(<Harness enabled={false} onDrop={leftDrop} />);
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/disabled.pdf"], position: { x: 10, y: 1 } } });
      await tauriWindowMocks.emit({ payload: { type: "enter", paths: ["/tmp/right.pdf"], position: { x: 90, y: 1 } } });
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/right.pdf"], position: { x: 90, y: 1 } } });
    });
    expect(leftDrop).toHaveBeenCalledTimes(1);
    expect(rightDrop).toHaveBeenCalledWith(["/tmp/right.pdf"], { x: 90, y: 1 });
    left.unmount();
    await act(async () => { await tauriWindowMocks.emit({ payload: { type: "leave" } }); });
    expect(right.container).toHaveTextContent("idle");
    expect(tauriWindowMocks.unlisten).not.toHaveBeenCalled();
    right.unmount();
  });

  it("reports native installation failure without retrying on component churn", async () => {
    const { useFeedbackStore } = await import("../state/feedback-store");
    useFeedbackStore.setState({ toasts: [] });
    tauriWindowMocks.onDragDropEvent.mockRejectedValueOnce(new Error("native registration failed"));
    const view = render(<Harness onDrop={vi.fn()} />);
    await waitFor(() => expect(useFeedbackStore.getState().toasts).toEqual([
      expect.objectContaining({ tone: "error", title: "无法启用文件拖放", detail: "Error: native registration failed" }),
    ]));
    view.unmount();
    const next = render(<Harness onDrop={vi.fn()} />);
    expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1);
    expect(tauriWindowMocks.unlisten).not.toHaveBeenCalled();
    next.unmount();
  });

  it("reports a subscriber failure while still delivering to another subscriber", async () => {
    const { useFeedbackStore } = await import("../state/feedback-store");
    useFeedbackStore.setState({ toasts: [] });
    const failedDrop = vi.fn(async () => { throw new Error("import failed"); });
    const otherDrop = vi.fn();
    const first = render(<Harness onDrop={failedDrop} />);
    const second = render(<Harness onDrop={otherDrop} />);
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/shared.pdf"], position: { x: 1, y: 1 } } });
    });
    expect(otherDrop).toHaveBeenCalledWith(["/tmp/shared.pdf"], { x: 1, y: 1 });
    expect(useFeedbackStore.getState().toasts).toEqual([
      expect.objectContaining({ tone: "error", title: "无法处理拖拽文件", detail: "Error: import failed" }),
    ]);
    first.unmount(); second.unmount();
  });

  it("does not subscribe outside the Tauri runtime", async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    render(<Harness onDrop={vi.fn()} />);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(tauriWindowMocks.onDragDropEvent).not.toHaveBeenCalled();
  });

  it("converts physical coordinates to CSS pixels before hit-testing and dropping", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const isPositionActive = vi.fn(({ x, y }: { x: number; y: number }) => x === 30 && y === 40);
    const onDrop = vi.fn();
    renderHook(() => useWindowFileDrop({ isPositionActive, onDrop }));
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 60, y: 80 } } });
    });
    expect(isPositionActive).toHaveBeenCalledWith({ x: 30, y: 40 });
    expect(onDrop).toHaveBeenCalledWith(["/tmp/file.pdf"], { x: 30, y: 40 });
  });

  it("reports CSS hover positions only inside the active region and clears them on leave", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const onHoverPosition = vi.fn();
    const onHoverChange = vi.fn();
    renderHook(() => useWindowFileDrop({
      onDrop: vi.fn(), onHoverPosition, onHoverChange,
      isPositionActive: ({ x }) => x < 50,
    }));
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "enter", paths: ["/tmp/file.pdf"], position: { x: 60, y: 80 } } });
    });
    expect(onHoverPosition).toHaveBeenLastCalledWith({ x: 30, y: 40 });
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 100, y: 80 } } });
    });
    expect(onHoverPosition).toHaveBeenLastCalledWith(null);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 80, y: 90 } } });
    });
    expect(onHoverPosition).toHaveBeenLastCalledWith({ x: 40, y: 45 });
    await act(async () => { await tauriWindowMocks.emit({ payload: { type: "leave" } }); });
    expect(onHoverPosition).toHaveBeenLastCalledWith(null);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
  });

  it("dispatches the drop before clearing hover, then awaits its asynchronous result", async () => {
    const order: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onDrop = vi.fn(() => { order.push("drop"); return pending; });
    renderHook(() => useWindowFileDrop({
      onDrop,
      onHoverPosition: (position) => { if (position === null) order.push("clear-position"); },
      onHoverChange: (active) => { if (!active) order.push("clear-hover"); },
    }));
    await act(async () => {
      const drop = tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } } });
      expect(onDrop).toHaveBeenCalledWith(["/tmp/file.pdf"], { x: 10, y: 20 });
      expect(order).toEqual(["drop", "clear-position", "clear-hover"]);
      finish();
      await drop;
    });
    expect(order).toEqual(["drop", "clear-position", "clear-hover"]);
  });

  it("keeps the native subscription while using updated hover, hit-test and drop callbacks", async () => {
    const first = { onDrop: vi.fn(), onHoverPosition: vi.fn(), onHoverChange: vi.fn(), isPositionActive: vi.fn(() => false) };
    const latest = { onDrop: vi.fn(), onHoverPosition: vi.fn(), onHoverChange: vi.fn(), isPositionActive: vi.fn(() => true) };
    const { rerender } = renderHook((handlers) => useWindowFileDrop(handlers), { initialProps: first });
    const unlisten = await tauriWindowMocks.onDragDropEvent.mock.results[0].value;
    rerender(latest);
    expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1);
    expect(unlisten).not.toHaveBeenCalled();
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
    });
    expect(latest.onHoverPosition).toHaveBeenLastCalledWith({ x: 10, y: 20 });
    expect(latest.onHoverChange).toHaveBeenLastCalledWith(true);
    expect(latest.isPositionActive).toHaveBeenCalledWith({ x: 10, y: 20 });
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } } });
    });
    expect(latest.onDrop).toHaveBeenCalledWith(["/tmp/file.pdf"], { x: 10, y: 20 });
    expect(first.onDrop).not.toHaveBeenCalled();
    expect(first.onHoverPosition).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])("reports a drop %s while clearing both hover signals", async (failureMode) => {
    const failure = new Error("Import failed");
    const onHoverPosition = vi.fn();
    const onHoverChange = vi.fn();
    renderHook(() => useWindowFileDrop({
      onDrop: () => {
        if (failureMode === "throw") throw failure;
        return Promise.reject(failure);
      },
      onHoverPosition, onHoverChange,
    }));
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
    });
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } } });
      const { useFeedbackStore } = await import("../state/feedback-store");
      expect(useFeedbackStore.getState().toasts).toEqual([expect.objectContaining({ tone: "error", title: "无法处理拖拽文件", detail: String(failure) })]);
    });
    expect(onHoverPosition).toHaveBeenLastCalledWith(null);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps hover-driven React rerenders from interrupting the native drag session", async () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() => {
      const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
      useWindowFileDrop({
        onDrop: (paths) => onDrop(paths),
        onHoverPosition: (next) => setPosition(next),
        isPositionActive: ({ x }) => x < 50,
      });
      return position;
    });
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
    });
    expect(result.current).toEqual({ x: 10, y: 20 });
    expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1);
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 20, y: 30 } } });
    });
    expect(result.current).toEqual({ x: 20, y: 30 });
    expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1);
  });

  it.each(["disable", "unmount"])("clears hover and removes the subscriber on %s, ignoring subsequent native events", async (action) => {
    const onHoverPosition = vi.fn();
    const onHoverChange = vi.fn();
    const onDrop = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useWindowFileDrop({ enabled, onDrop, onHoverPosition, onHoverChange }),
      { initialProps: { enabled: true } },
    );
    const unlisten = await tauriWindowMocks.onDragDropEvent.mock.results[0].value;
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
    });
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    if (action === "disable") rerender({ enabled: false });
    else unmount();
    expect(unlisten).not.toHaveBeenCalled();
    expect(onHoverPosition).toHaveBeenLastCalledWith(null);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
    onHoverPosition.mockClear();
    onHoverChange.mockClear();
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } } });
    });
    expect(onHoverPosition).not.toHaveBeenCalled();
    expect(onHoverChange).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("leaves native registration window-owned when it resolves after unmount", async () => {
    const unlisten = vi.fn();
    let finish!: (unlisten: () => void) => void;
    tauriWindowMocks.onDragDropEvent.mockImplementationOnce(() => new Promise<() => void>((resolve) => { finish = resolve; }));
    const { unmount } = renderHook(() => useWindowFileDrop({ onDrop: vi.fn() }));
    unmount();
    await act(async () => { finish(unlisten); });
    expect(unlisten).not.toHaveBeenCalled();
  });

  it("does not clear a newer drag when an earlier drop finishes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onHoverPosition = vi.fn();
    const onHoverChange = vi.fn();
    renderHook(() => useWindowFileDrop({ onDrop: () => pending, onHoverPosition, onHoverChange }));
    let drop: void | Promise<void>;
    act(() => { drop = tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } } }); });
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "enter", paths: ["/tmp/new.pdf"], position: { x: 30, y: 40 } } });
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 35, y: 45 } } });
    });
    await act(async () => { finish(); await drop; });
    expect(onHoverPosition).toHaveBeenLastCalledWith({ x: 35, y: 45 });
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
  });

  it("does not call updated or unmounted handlers when an earlier drop finishes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const first = { onHoverPosition: vi.fn(), onHoverChange: vi.fn() };
    const latest = { onHoverPosition: vi.fn(), onHoverChange: vi.fn() };
    const { rerender, unmount } = renderHook(
      (handlers) => useWindowFileDrop({ onDrop: () => pending, ...handlers }),
      { initialProps: first },
    );
    let drop: void | Promise<void>;
    act(() => { drop = tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } } }); });
    rerender(latest);
    unmount();
    for (const handlers of [first, latest]) {
      handlers.onHoverPosition.mockClear();
      handlers.onHoverChange.mockClear();
    }
    await act(async () => { finish(); await drop; });
    for (const handlers of [first, latest]) {
      expect(handlers.onHoverPosition).not.toHaveBeenCalled();
      expect(handlers.onHoverChange).not.toHaveBeenCalled();
    }
  });

  it("keeps a newer subscriber drag when window-owned registration fails late", async () => {
    let fail!: (error: Error) => void;
    tauriWindowMocks.blockRegistration(new Promise<void>((_resolve, reject) => { fail = reject; }));
    const onHoverPosition = vi.fn();
    const onHoverChange = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useWindowFileDrop({ enabled, onDrop: vi.fn(), onHoverPosition, onHoverChange }),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 30, y: 40 } } });
      fail(new Error("Old listener unavailable"));
    });
    expect(tauriWindowMocks.onDragDropEvent).toHaveBeenCalledTimes(1);
    expect(tauriWindowMocks.unlisten).not.toHaveBeenCalled();
    const { useFeedbackStore } = await import("../state/feedback-store");
    expect(useFeedbackStore.getState().toasts).toEqual([
      expect.objectContaining({ tone: "error", title: "无法启用文件拖放", detail: "Error: Old listener unavailable" }),
    ]);
    expect(onHoverPosition).toHaveBeenLastCalledWith({ x: 30, y: 40 });
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
  });

  it.each(["outside", "empty"])("clears an %s drop without forwarding paths", async (reason) => {
    const onDrop = vi.fn();
    const onHoverPosition = vi.fn();
    const onHoverChange = vi.fn();
    renderHook(() => useWindowFileDrop({
      onDrop, onHoverPosition, onHoverChange,
      isPositionActive: ({ x }) => x < 50,
    }));
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
      await tauriWindowMocks.emit({ payload: {
        type: "drop", paths: reason === "empty" ? [] : ["/tmp/file.pdf"],
        position: { x: reason === "outside" ? 50 : 10, y: 20 },
      } });
    });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onHoverPosition).toHaveBeenLastCalledWith(null);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
  });

  it("delivers only one drop per drag even while pending, after completion, or after leave", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onDrop = vi.fn(() => pending);
    renderHook(() => useWindowFileDrop({ onDrop }));
    const payload: DragDropPayload = { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } };
    let first: void | Promise<void>;
    act(() => { first = tauriWindowMocks.emit({ payload }); });
    let duplicate: void | Promise<void>;
    act(() => { duplicate = tauriWindowMocks.emit({ payload }); });
    expect(onDrop).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await first; await duplicate; });
    await act(async () => {
      await tauriWindowMocks.emit({ payload });
      await tauriWindowMocks.emit({ payload: { type: "leave" } });
      await tauriWindowMocks.emit({ payload });
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it.each(["enter", "over"] as const)("allows the next drag after a new %s event", async (type) => {
    const onDrop = vi.fn();
    renderHook(() => useWindowFileDrop({ onDrop }));
    const position = { x: 10, y: 20 };
    const payload: DragDropPayload = { type: "drop", paths: ["/tmp/file.pdf"], position };
    await act(async () => {
      await tauriWindowMocks.emit({ payload });
      await tauriWindowMocks.emit({ payload: type === "enter" ? { type, paths: ["/tmp/file.pdf"], position } : { type, position } });
      await tauriWindowMocks.emit({ payload });
      await tauriWindowMocks.emit({ payload });
    });
    expect(onDrop).toHaveBeenCalledTimes(2);
  });

  it.each(["throw", "reject"])("does not retry a failed %s until the user drags in again", async (failureMode) => {
    const failure = new Error("Import failed");
    const onDrop = vi.fn<() => void | Promise<unknown>>(() => undefined);
    onDrop.mockImplementationOnce(() => {
      if (failureMode === "throw") throw failure;
      return Promise.reject(failure);
    });
    renderHook(() => useWindowFileDrop({ onDrop }));
    const payload: DragDropPayload = { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } };
    await act(async () => {
      await tauriWindowMocks.emit({ payload });
      const { useFeedbackStore } = await import("../state/feedback-store");
      expect(useFeedbackStore.getState().toasts).toEqual([expect.objectContaining({ tone: "error", title: "无法处理拖拽文件", detail: String(failure) })]);
      await tauriWindowMocks.emit({ payload });
      await tauriWindowMocks.emit({ payload: { type: "leave" } });
      await tauriWindowMocks.emit({ payload });
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
    await act(async () => {
      await tauriWindowMocks.emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
      await tauriWindowMocks.emit({ payload });
    });
    expect(onDrop).toHaveBeenCalledTimes(2);
  });

  it("ignores native events after disable commits but before passive cleanup", async () => {
    const onDrop = vi.fn();
    const onHoverPosition = vi.fn();
    const onHoverChange = vi.fn();
    const { rerender } = renderHook(({ enabled }) => {
      useWindowFileDrop({ enabled, onDrop, onHoverPosition, onHoverChange });
      useLayoutEffect(() => {
        if (!enabled) {
          expect(unlisten).not.toHaveBeenCalled();
          void tauriWindowMocks.emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
          void tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } } });
        }
      }, [enabled]);
    }, { initialProps: { enabled: true } });
    const unlisten = await tauriWindowMocks.onDragDropEvent.mock.results[0].value;
    rerender({ enabled: false });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onHoverPosition.mock.calls).toEqual([[null]]);
    expect(onHoverChange.mock.calls).toEqual([[false]]);
    expect(unlisten).not.toHaveBeenCalled();
  });
});
