import { TODO_LAYOUT_DURATION_MS, TODO_MOTION_EASING } from "./todo-motion";
import { useEffect, useLayoutEffect, useRef } from "react";

/** Preserve card positions across asynchronous list updates. */
export function useTodoListMotion() {
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const cardPositions = useRef(new Map<string, number>());
  const cardAnimations = useRef(new Map<HTMLElement, Animation>());

  // Measure after each React layout so asynchronous data refreshes also animate.
  useLayoutEffect(() => {
    const container = listScrollRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect().top - container.scrollTop;
    const nextPositions = new Map<string, number>();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    container.querySelectorAll<HTMLElement>("[data-layout-motion-id]").forEach((card) => {
      const key = card.dataset.layoutMotionId!;
      const active = cardAnimations.current.get(card);
      const offset = active ? new DOMMatrixReadOnly(getComputedStyle(card).transform).m42 : 0;
      const top = card.getBoundingClientRect().top - origin - offset;
      nextPositions.set(key, top);
      const previous = cardPositions.current.get(key);
      if (previous === undefined || Math.abs(previous - top) < .5) return;
      active?.cancel();
      if (reduced || !card.animate || card.dataset.state?.includes("completing")) return;
      const animation = card.animate([
        { transform: `translateY(${previous + offset - top}px)` },
        { transform: "translateY(0)" },
      ], { duration: TODO_LAYOUT_DURATION_MS, easing: TODO_MOTION_EASING });
      cardAnimations.current.set(card, animation);
      animation.onfinish = () => cardAnimations.current.delete(card);
    });
    cardPositions.current = nextPositions;
    cardAnimations.current.forEach((animation, card) => {
      if (!container.contains(card)) { animation.cancel(); cardAnimations.current.delete(card); }
    });
  });
  useEffect(() => () => {
    cardAnimations.current.forEach((animation) => animation.cancel());
    cardAnimations.current.clear();
  }, []);

  return listScrollRef;
}
