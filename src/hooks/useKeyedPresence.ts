import { useCallback, useEffect, useRef, useState } from "react";

import { cancelListLayoutMotion, commitListLayoutChange } from "../ui/listLayoutMotion";
import { MOTION_DURATION_MS } from "../ui/motion";

export type KeyedPresenceItem<T> = {
  item: T;
  key: string;
  state: "entering" | "present" | "exiting";
};

export function useKeyedPresence<T>(
  items: T[],
  getKey: (item: T) => string,
  resetKey: string,
) {
  const [rendered, setRendered] = useState<KeyedPresenceItem<T>[]>(() =>
    items.map((item) => ({ item, key: getKey(item), state: "present" })),
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const motionContainerRef = useRef<HTMLDivElement | null>(null);
  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    if (element) motionContainerRef.current = element;
  }, []);
  const getKeyRef = useRef(getKey);
  getKeyRef.current = getKey;
  const initializedRef = useRef(items.length > 0);
  const previousResetKeyRef = useRef(resetKey);
  const exitTimersRef = useRef(new Map<string, number>());

  function finishExit(key: string) {
    const timer = exitTimersRef.current.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    exitTimersRef.current.delete(key);
    commitListLayoutChange(containerRef.current, () => {
      setRendered((current) => current.filter((entry) => entry.key !== key));
    });
  }

  useEffect(() => {
    const reset = previousResetKeyRef.current !== resetKey || !initializedRef.current;
    previousResetKeyRef.current = resetKey;
    if (items.length > 0) initializedRef.current = true;

    commitListLayoutChange(containerRef.current, () => {
      setRendered((current) => {
        if (reset) {
          return items.map((item) => ({ item, key: getKeyRef.current(item), state: "present" }));
        }
        const incoming = new Map(items.map((item) => [getKeyRef.current(item), item]));
        const next = current.map((entry) => {
          const replacement = incoming.get(entry.key);
          if (!replacement) return { ...entry, state: "exiting" as const };
          incoming.delete(entry.key);
          return { item: replacement, key: entry.key, state: "present" as const };
        });
        return [
          ...Array.from(incoming, ([key, item]) => ({ item, key, state: "entering" as const })),
          ...next,
        ];
      });
    });
  }, [items, resetKey]);

  useEffect(() => {
    const entering = rendered.some((entry) => entry.state === "entering");
    let frame = 0;
    if (entering) {
      frame = window.requestAnimationFrame(() => {
        setRendered((current) => current.map((entry) =>
          entry.state === "entering" ? { ...entry, state: "present" } : entry,
        ));
      });
    }
    const exitingKeys = new Set(
      rendered.filter((entry) => entry.state === "exiting").map((entry) => entry.key),
    );
    for (const [key, timer] of exitTimersRef.current) {
      if (!exitingKeys.has(key)) {
        window.clearTimeout(timer);
        exitTimersRef.current.delete(key);
      }
    }
    for (const key of exitingKeys) {
      if (exitTimersRef.current.has(key)) continue;
      const exitingElement = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>("[data-layout-motion-id]") ?? [],
      ).find((element) => element.dataset.layoutMotionId === `record-${key}`);
      if (exitingElement?.contains(document.activeElement)) containerRef.current?.focus();
      const timer = window.setTimeout(() => finishExit(key), MOTION_DURATION_MS.standard);
      exitTimersRef.current.set(key, timer);
    }
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [rendered]);

  useEffect(() => {
    return () => {
      exitTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      exitTimersRef.current.clear();
      cancelListLayoutMotion(motionContainerRef.current);
    };
  }, []);

  const visibleItems = !initializedRef.current && items.length > 0
    ? items.map((item) => ({
        item,
        key: getKeyRef.current(item),
        state: "present" as const,
      }))
    : rendered;

  return { items: visibleItems, containerRef: setContainerRef, finishExit };
}
