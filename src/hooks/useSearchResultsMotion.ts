import { useLayoutEffect, useRef, type RefObject } from "react";

/** Animate the result surface without remounting rows or losing keyboard focus. */
export function useSearchResultsMotion(ref: RefObject<HTMLElement | null>, resultKey: string | undefined) {
  const previous = useRef(resultKey);
  useLayoutEffect(() => {
    const changed = previous.current !== resultKey;
    previous.current = resultKey;
    const node = ref.current;
    if (!changed || resultKey === undefined || !node?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const style = getComputedStyle(node);
    const duration = parseFloat(style.getPropertyValue("--duration-standard")) || 160;
    const easing = style.getPropertyValue("--ease-soft").trim() || "cubic-bezier(0.23, 1, 0.32, 1)";
    const animation = node.animate([{ opacity: .6, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }], { duration, easing });
    return () => animation.cancel();
  }, [ref, resultKey]);
}
