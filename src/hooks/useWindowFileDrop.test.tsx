import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
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
    return () => { unlisten(); handlers.delete(handler); };
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
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
      },
    };
  });

  afterEach(() => {
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

    expect(onDrop).toHaveBeenCalledWith(["/tmp/project-atlas/inbox/brief.pdf"]);
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
    expect(latestDrop).toHaveBeenCalledWith(["/tmp/latest.pdf"]);
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
      await tauriWindowMocks.emit({ payload: { type: "drop", paths: ["/tmp/right.pdf"], position: { x: 90, y: 1 } } });
    });
    expect(leftDrop).toHaveBeenCalledTimes(1);
    expect(rightDrop).toHaveBeenCalledWith(["/tmp/right.pdf"]);
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
    expect(otherDrop).toHaveBeenCalledWith(["/tmp/shared.pdf"]);
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
});
