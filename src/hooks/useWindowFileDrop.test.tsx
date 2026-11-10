import { act } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

const tauriWindowMocks = vi.hoisted(() => {
  let dragDropHandler: ((event: { payload: DragDropPayload }) => void | Promise<void>) | null = null;

  return {
    onDragDropEvent: vi.fn(async (handler: (event: { payload: DragDropPayload }) => void | Promise<void>): Promise<() => void> => {
      dragDropHandler = handler;
      return vi.fn(() => {});
    }),
    emit(event: { payload: DragDropPayload }) {
      return dragDropHandler?.(event);
    },
    reset() {
      dragDropHandler = null;
      this.onDragDropEvent.mockReset();
      this.onDragDropEvent.mockImplementation(async (handler) => {
        dragDropHandler = handler;
        return vi.fn(() => {});
      });
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: tauriWindowMocks.onDragDropEvent,
  }),
}));

import { useWindowFileDrop } from "./useWindowFileDrop";

function Harness({
  enabled = true,
  onDrop,
}: {
  enabled?: boolean;
  onDrop: (paths: string[]) => void | Promise<unknown>;
}) {
  const [hovering, setHovering] = useState(false);

  useWindowFileDrop({
    enabled,
    onDrop,
    onHoverChange: setHovering,
  });

  return <div>{hovering ? "hovering" : "idle"}</div>;
}

describe("useWindowFileDrop", () => {
  const originalTauriInternals = (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

  beforeEach(() => {
    tauriWindowMocks.reset();
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

  it.each(["throw", "reject"])("propagates a drop %s while clearing both hover signals", async (failureMode) => {
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
      await expect(tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/file.pdf"], position: { x: 10, y: 20 } } })).rejects.toBe(failure);
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

  it.each(["disable", "unmount"])("clears hover and unsubscribes on %s, ignoring subsequent native events", async (action) => {
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
    expect(unlisten).toHaveBeenCalledOnce();
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

  it("unsubscribes even when native registration resolves after unmount", async () => {
    const unlisten = vi.fn();
    let finish!: (unlisten: () => void) => void;
    tauriWindowMocks.onDragDropEvent.mockImplementationOnce(() => new Promise<() => void>((resolve) => { finish = resolve; }));
    const { unmount } = renderHook(() => useWindowFileDrop({ onDrop: vi.fn() }));
    unmount();
    await act(async () => { finish(unlisten); });
    expect(unlisten).toHaveBeenCalledOnce();
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

  it("ignores a disposed subscription failure without clearing a newer drag", async () => {
    let fail!: (error: Error) => void;
    tauriWindowMocks.onDragDropEvent.mockImplementationOnce(() => new Promise<() => void>((_resolve, reject) => { fail = reject; }));
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
});
