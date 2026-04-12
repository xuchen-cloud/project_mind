import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
    onDragDropEvent: vi.fn(async (handler: (event: { payload: DragDropPayload }) => void | Promise<void>) => {
      dragDropHandler = handler;
      return vi.fn();
    }),
    emit(event: { payload: DragDropPayload }) {
      return dragDropHandler?.(event);
    },
    reset() {
      dragDropHandler = null;
      this.onDragDropEvent.mockReset();
      this.onDragDropEvent.mockImplementation(async (handler) => {
        dragDropHandler = handler;
        return vi.fn();
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

  it("does not subscribe outside the Tauri runtime", async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    render(<Harness onDrop={vi.fn()} />);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(tauriWindowMocks.onDragDropEvent).not.toHaveBeenCalled();
  });
});
