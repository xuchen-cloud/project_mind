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
  onDrop: (paths: string[]) => void | Promise<unknown>;
  onHoverChange?: (active: boolean) => void;
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
  isPositionActive,
}: UseWindowFileDropOptions) {
  const nativeWindowFileDrop = isTauriRuntime();
  const latest = useRef({ enabled, onDrop, onHoverChange, isPositionActive });
  useLayoutEffect(() => {
    latest.current = { enabled, onDrop, onHoverChange, isPositionActive };
  });

  useEffect(() => {
    if (!enabled || !nativeWindowFileDrop) return;
    let disposed = false;
    const subscriber: FileDropSubscriber = async (payload) => {
      const current = latest.current;
      if (disposed || !current.enabled) return;
      const isActiveAtPosition = "position" in payload
        ? (current.isPositionActive?.(payload.position) ?? true) : false;
      switch (payload.type) {
        case "enter":
        case "over":
          current.onHoverChange?.(isActiveAtPosition);
          return;
        case "leave":
          current.onHoverChange?.(false);
          return;
        case "drop":
          current.onHoverChange?.(false);
          if (payload.paths.length > 0 && isActiveAtPosition) await current.onDrop(payload.paths);
      }
    };
    subscribers.add(subscriber);
    ensureNativeSubscription();
    return () => {
      disposed = true;
      subscribers.delete(subscriber);
      latest.current.onHoverChange?.(false);
    };
  }, [enabled, nativeWindowFileDrop]);

  return { nativeWindowFileDrop };
}
