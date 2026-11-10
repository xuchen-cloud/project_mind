import { useEffect, useLayoutEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface DragDropPosition {
  x: number;
  y: number;
}

interface UseWindowFileDropOptions {
  enabled?: boolean;
  /** Position is in CSS pixels. Consume any ready target before the first await. */
  onDrop: (paths: string[], position?: DragDropPosition) => void | Promise<unknown>;
  onHoverChange?: (active: boolean) => void;
  onHoverPosition?: (position: DragDropPosition | null) => void;
  isPositionActive?: (position: DragDropPosition) => boolean;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useWindowFileDrop({
  enabled = true,
  onDrop,
  onHoverChange,
  onHoverPosition,
  isPositionActive,
}: UseWindowFileDropOptions) {
  const nativeWindowFileDrop = isTauriRuntime();
  // Commit callback updates without restarting an active native drag subscription.
  const handlers = useRef({ onDrop, onHoverChange, onHoverPosition, isPositionActive });
  useLayoutEffect(() => {
    handlers.current = { onDrop, onHoverChange, onHoverPosition, isPositionActive };
  });

  useEffect(() => {
    if (!enabled || !nativeWindowFileDrop) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const clearHover = () => {
      const { onHoverPosition, onHoverChange } = handlers.current;
      onHoverPosition?.(null);
      onHoverChange?.(false);
    };

    void getCurrentWindow()
      .onDragDropEvent(async ({ payload }) => {
        if (disposed) {
          return;
        }
        const { onDrop, onHoverPosition, onHoverChange, isPositionActive } = handlers.current;

        // Tauri reports physical pixels; DOM hit tests and hover UI use CSS pixels.
        const position = "position" in payload
          ? { x: payload.position.x / window.devicePixelRatio, y: payload.position.y / window.devicePixelRatio }
          : undefined;
        const isActiveAtPosition = position ? (isPositionActive?.(position) ?? true) : false;

        switch (payload.type) {
          case "enter":
          case "over":
            onHoverPosition?.(isActiveAtPosition ? position! : null);
            onHoverChange?.(isActiveAtPosition);
            return;
          case "leave":
            clearHover();
            return;
          case "drop": {
            let result: void | Promise<unknown> = undefined;
            try {
              if (payload.paths.length > 0 && isActiveAtPosition) {
                result = onDrop(payload.paths, position);
              }
            } finally {
              // The handler consumes its target synchronously before this reset.
              // Clear before awaiting I/O so completion cannot reset a newer drag.
              clearHover();
            }
            await result;
          }
        }
      })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }

        unlisten = nextUnlisten;
      })
      .catch(() => {
        if (!disposed) clearHover();
      });

    return () => {
      disposed = true;
      clearHover();
      unlisten?.();
    };
  }, [enabled, nativeWindowFileDrop]);

  return {
    nativeWindowFileDrop,
  };
}
