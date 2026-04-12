import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface UseWindowFileDropOptions {
  enabled?: boolean;
  onDrop: (paths: string[]) => void | Promise<unknown>;
  onHoverChange?: (active: boolean) => void;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useWindowFileDrop({
  enabled = true,
  onDrop,
  onHoverChange,
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

        switch (payload.type) {
          case "enter":
          case "over":
            onHoverChange?.(true);
            return;
          case "leave":
            onHoverChange?.(false);
            return;
          case "drop":
            onHoverChange?.(false);
            if (payload.paths.length > 0) {
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
  }, [enabled, nativeWindowFileDrop, onDrop, onHoverChange]);

  return {
    nativeWindowFileDrop,
  };
}
