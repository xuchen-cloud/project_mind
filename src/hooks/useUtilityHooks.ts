import { useEffect, useState } from "react";

export function useFocusTarget(focusId: string | null, deps: unknown[]) {
  useEffect(() => {
    if (!focusId) return;
    const element = document.getElementById(focusId);
    if (!element) return;

    const scrollContainer = element.closest(
      "[data-testid='project-overview-focus-scroll'], [data-testid='workspace-overview-focus-scroll']",
    ) as HTMLElement | null;

    if (scrollContainer) {
      const scrollToTarget = () => {
        const containerRect = scrollContainer.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const targetTop =
          scrollContainer.scrollTop +
          elementRect.top -
          containerRect.top -
          Math.max(24, (containerRect.height - elementRect.height) / 2);

        const nextTop = Math.max(0, targetTop);
        if (typeof scrollContainer.scrollTo === "function") {
          scrollContainer.scrollTo({
            top: nextTop,
            behavior: "smooth",
          });
        } else {
          scrollContainer.scrollTop = nextTop;
        }
      };

      scrollToTarget();
      const frame = window.requestAnimationFrame(scrollToTarget);
      const firstTimer = window.setTimeout(scrollToTarget, 80);
      const secondTimer = window.setTimeout(scrollToTarget, 240);

      element.classList.add("is-focused");
      const timer = window.setTimeout(() => element.classList.remove("is-focused"), 1600);
      return () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(firstTimer);
        window.clearTimeout(secondTimer);
        window.clearTimeout(timer);
      };
    }

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
