import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Enable only for the visible owner and render the hint whenever readyTarget
 * is non-null. Call leave on scroll/layout target changes; consume synchronously
 * at drop before starting asynchronous persistence. */
export function useFileDropTarget<T extends { id: number }>({
  enabled,
  scopeKey,
  delayMs = 750,
}: { enabled: boolean; scopeKey: string | number | null; delayMs?: number }) {
  const [readyTarget, setReadyTarget] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedTarget = useRef<T | null>(null);
  const hoveredTarget = useRef<T | null>(null);
  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    committedTarget.current = null;
    hoveredTarget.current = null;
  }, []);
  const reset = useCallback(() => {
    clear();
    setReadyTarget(null);
  }, [clear]);
  useLayoutEffect(() => {
    reset();
    return clear;
  }, [enabled, scopeKey, reset, clear]);
  useLayoutEffect(() => {
    // A timer (or an interrupted render) alone must never authorize replacement.
    // Layout effects run after the prompt's DOM has committed.
    committedTarget.current = hoveredTarget.current === readyTarget ? readyTarget : null;
  }, [readyTarget]);
  const hover = (target: T | null) => {
    if (enabled && target && hoveredTarget.current?.id === target.id) return;
    reset();
    if (enabled && target) {
      // Keep the first displayed fields/CAS baseline across repeated same-id over.
      hoveredTarget.current = { ...target };
      const snapshot = hoveredTarget.current;
      timer.current = setTimeout(() => setReadyTarget(snapshot), delayMs);
    }
  };
  const consume = () => {
    const target = committedTarget.current;
    reset();
    return target;
  };

  return { hover, leave: reset, readyTarget, consume, reset };
}
