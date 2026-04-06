import { useEffect, useState } from "react";

export function useFocusTarget(focusId: string | null, deps: unknown[]) {
  useEffect(() => {
    if (!focusId) return;
    const element = document.getElementById(focusId);
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    element.classList.add("is-focused");
    const timer = window.setTimeout(() => element.classList.remove("is-focused"), 1600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, ...deps]);
}

export function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}
