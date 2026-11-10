import { useEffect, useLayoutEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { useFeedbackStore } from "../state/feedback-store";

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

type FileDropSubscriber = (payload: DragDropEvent) => Promise<void>;
const subscribers = new Set<FileDropSubscriber>();
let nativeSubscription: Promise<void> | null = null;

function reportFileDropError(title: string, error: unknown) {
  useFeedbackStore.getState().pushToast({ tone: "error", title, detail: String(error) });
}

function ensureNativeSubscription() {
  if (nativeSubscription) return;
  // This module lives in one webview. Its four native listeners belong to that
  // webview and are reclaimed with it, even while no component is subscribed.
  // SDK unlisten starts four unawaited async cleanups; component churn must not
  // invoke it while the native listen ACK can precede JS listener installation.
  nativeSubscription = getCurrentWindow().onDragDropEvent(async ({ payload }) => {
    await Promise.all([...subscribers].map(subscriber => subscriber(payload).catch(error => {
      reportFileDropError("无法处理拖拽文件", error);
    })));
  }).then(() => undefined).catch(error => {
    reportFileDropError("无法启用文件拖放", error);
  });
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
  const handlers = useRef({ enabled, onDrop, onHoverChange, onHoverPosition, isPositionActive });
  useLayoutEffect(() => {
    handlers.current = { enabled, onDrop, onHoverChange, onHoverPosition, isPositionActive };
  });

  useEffect(() => {
    if (!enabled || !nativeWindowFileDrop) return;
    let disposed = false;
    let delivered = false;
    const clearHover = () => {
      const { onHoverPosition, onHoverChange } = handlers.current;
      onHoverPosition?.(null);
      onHoverChange?.(false);
    };
    const subscriber: FileDropSubscriber = async (payload) => {
      if (disposed || !handlers.current.enabled) return;
      const { onDrop, onHoverPosition, onHoverChange, isPositionActive } = handlers.current;
      // Tauri reports physical pixels; DOM hit tests and hover UI use CSS pixels.
      const position = "position" in payload
        ? { x: payload.position.x / window.devicePixelRatio, y: payload.position.y / window.devicePixelRatio }
        : undefined;
      const isActiveAtPosition = position ? (isPositionActive?.(position) ?? true) : false;
      switch (payload.type) {
        case "enter":
        case "over":
          delivered = false;
          onHoverPosition?.(isActiveAtPosition ? position! : null);
          onHoverChange?.(isActiveAtPosition);
          return;
        case "leave":
          // Leaving clears the prompt without rearming a delivered drop.
          clearHover();
          return;
        case "drop": {
          if (delivered) return;
          // Mark before dispatch, including failures: duplicates are not retries.
          delivered = true;
          let result: void | Promise<unknown> = undefined;
          try {
            if (payload.paths.length > 0 && isActiveAtPosition) {
              result = onDrop(payload.paths, position);
            }
          } finally {
            // Consume the target synchronously; late I/O cannot reset a newer drag.
            clearHover();
          }
          await result;
        }
      }
    };
    subscribers.add(subscriber);
    ensureNativeSubscription();
    return () => {
      disposed = true;
      subscribers.delete(subscriber);
      clearHover();
    };
  }, [enabled, nativeWindowFileDrop]);

  return { nativeWindowFileDrop };
}
