import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface DragDropPosition {
  x: number;
  y: number;
}

interface UseWindowFileDropOptions {
  enabled?: boolean;
  onDrop: (paths: string[]) => void | Promise<unknown>;
  onHoverChange?: (active: boolean) => void;
  isPositionActive?: (position: DragDropPosition) => boolean;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useWindowFileDrop({
  enabled = true,
  onDrop,
  onHoverChange,
  isPositionActive,
}: UseWindowFileDropOptions) {
  const nativeWindowFileDrop = isTauriRuntime();

  useEffect(() => {
    if (!enabled || !nativeWindowFileDrop) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWindow()
      .onDragDropEvent(async ({ payload }) => {
        if (disposed) {
          return;
        }

        const isActiveAtPosition =
          "position" in payload ? (isPositionActive?.(payload.position) ?? true) : false;

        switch (payload.type) {
          case "enter":
          case "over":
            onHoverChange?.(isActiveAtPosition);
            return;
          case "leave":
            onHoverChange?.(false);
            return;
          case "drop":
            onHoverChange?.(false);
            if (payload.paths.length > 0 && isActiveAtPosition) {
              await onDrop(payload.paths);
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
        onHoverChange?.(false);
      });

    return () => {
      disposed = true;
      onHoverChange?.(false);
      unlisten?.();
    };
  }, [enabled, isPositionActive, nativeWindowFileDrop, onDrop, onHoverChange]);

  return {
    nativeWindowFileDrop,
  };
}
