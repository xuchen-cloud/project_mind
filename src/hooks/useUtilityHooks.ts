import { useCallback, useEffect, useRef, useState } from "react";

const scrollPositions = new Map<string, number>();
const MAX_SAVED_SCROLL_POSITIONS = 100;

function rememberScrollPosition(key: string, position: number) {
  scrollPositions.delete(key);
  scrollPositions.set(key, position);
  while (scrollPositions.size > MAX_SAVED_SCROLL_POSITIONS) {
    const oldestKey = scrollPositions.keys().next().value;
    if (oldestKey === undefined) break;
    scrollPositions.delete(oldestKey);
  }
}

interface FocusTargetOptions {
  enabled?: boolean;
  refocusOnEnable?: boolean;
}

export function useFocusTarget(
  focusId: string | null,
  deps: unknown[],
  { enabled = true, refocusOnEnable = true }: FocusTargetOptions = {},
) {
  const lastFocusedIdRef = useRef<string | null>(null);
  const wasEnabledRef = useRef(enabled);

  useEffect(() => {
    const wasEnabled = wasEnabledRef.current;
    wasEnabledRef.current = enabled;

    if (!focusId) {
      lastFocusedIdRef.current = null;
      return;
    }
    if (!enabled) return;
    if (!wasEnabled && !refocusOnEnable && lastFocusedIdRef.current === focusId) return;

    const element = document.getElementById(focusId);
    if (!element) return;
    lastFocusedIdRef.current = focusId;

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
  }, [enabled, focusId, refocusOnEnable, ...deps]);
}

export function useScrollPositionRestoration(key: string) {
  const elementRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const hasSavedPosition = scrollPositions.has(key);

  const scrollRef = useCallback((element: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    elementRef.current = element;
    if (!element) return;

    const savedPosition = scrollPositions.get(key) ?? 0;
    let restoreTarget: number | null = savedPosition > 0 ? savedPosition : null;
    if (restoreTarget === null) {
      element.scrollTop = 0;
    }
    let restoreFrame: number | null = null;
    let disposed = false;
    const restoreTimers: number[] = [];

    const restore = () => {
      restoreFrame = null;
      if (disposed || restoreTarget === null) return;

      // Browsers clamp this naturally while content is still short. Keeping
      // the original target lets the observers retry once the editor expands.
      element.scrollTop = restoreTarget;
    };
    const scheduleRestore = () => {
      if (disposed || restoreTarget === null || restoreFrame !== null) return;
      restoreFrame = window.requestAnimationFrame(restore);
    };
    const remember = () => {
      if (restoreTarget !== null) {
        // RichEditor mounts its document after the Focus shell. Until its
        // content has a real height, assigning the saved offset is clamped to
        // zero. Do not overwrite the saved value with that temporary zero.
        scheduleRestore();
        return;
      }
      rememberScrollPosition(key, element.scrollTop);
    };
    const takeUserControl = () => {
      if (restoreTarget === null) return;
      restoreTarget = null;
      rememberScrollPosition(key, element.scrollTop);
    };

    element.addEventListener("scroll", remember, { passive: true });
    element.addEventListener("wheel", takeUserControl, { passive: true });
    element.addEventListener("touchstart", takeUserControl, { passive: true });
    element.addEventListener("pointerdown", takeUserControl, { passive: true });
    element.addEventListener("keydown", takeUserControl, true);

    let observedContent: Element | null = null;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleRestore();
          });
    const observeContent = () => {
      const nextContent = element.firstElementChild;
      if (!resizeObserver || nextContent === observedContent) return;
      if (observedContent) resizeObserver.unobserve(observedContent);
      observedContent = nextContent;
      if (observedContent) resizeObserver.observe(observedContent);
    };
    resizeObserver?.observe(element);
    observeContent();

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            observeContent();
            scheduleRestore();
          });
    mutationObserver?.observe(element, { childList: true, subtree: true });

    if (restoreTarget !== null) {
      restore();
      scheduleRestore();
      for (const delay of [50, 150, 500]) {
        restoreTimers.push(window.setTimeout(scheduleRestore, delay));
      }
    }

    cleanupRef.current = () => {
      disposed = true;
      // If the editor was removed before it finished laying out, retain the
      // intended offset instead of replacing it with a clamped interim value.
      rememberScrollPosition(key, restoreTarget ?? element.scrollTop);
      element.removeEventListener("scroll", remember);
      element.removeEventListener("wheel", takeUserControl);
      element.removeEventListener("touchstart", takeUserControl);
      element.removeEventListener("pointerdown", takeUserControl);
      element.removeEventListener("keydown", takeUserControl, true);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
      for (const timer of restoreTimers) window.clearTimeout(timer);
      if (elementRef.current === element) elementRef.current = null;
    };
  }, [key]);

  return { scrollRef, hasSavedPosition };
}

export function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}
