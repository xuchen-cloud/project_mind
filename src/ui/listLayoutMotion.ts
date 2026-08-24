import { MOTION_DURATION_MS } from "./motion";

const activeFrames = new WeakMap<Element, number[]>();
const activeTimers = new WeakMap<Element, number[]>();

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function clearPending(container: Element) {
  activeFrames.get(container)?.forEach((frame) => window.cancelAnimationFrame(frame));
  activeTimers.get(container)?.forEach((timer) => window.clearTimeout(timer));
  activeFrames.delete(container);
  activeTimers.delete(container);
}

export function commitListLayoutChange(container: Element | null, update: () => void) {
  if (!container || prefersReducedMotion()) {
    update();
    return;
  }

  const items = Array.from(container.querySelectorAll<HTMLElement>("[data-layout-motion-id]"));
  const previousTops = new Map(
    items.map((item) => [item.dataset.layoutMotionId, item.getBoundingClientRect().top]),
  );

  clearPending(container);
  for (const item of items) {
    delete item.dataset.layoutMotion;
    item.style.removeProperty("--list-layout-delta-y");
  }
  update();

  const measureFrame = window.requestAnimationFrame(() => {
    const movedItems = Array.from(
      container.querySelectorAll<HTMLElement>("[data-layout-motion-id]"),
    );

    for (const item of movedItems) {
      const previousTop = previousTops.get(item.dataset.layoutMotionId);
      if (previousTop === undefined) continue;
      const deltaY = previousTop - item.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 0.5) continue;
      item.style.setProperty("--list-layout-delta-y", `${deltaY}px`);
      item.dataset.layoutMotion = "inverted";
    }

    const playFrame = window.requestAnimationFrame(() => {
      for (const item of movedItems) {
        if (item.dataset.layoutMotion !== "inverted") continue;
        item.dataset.layoutMotion = "playing";
        item.style.setProperty("--list-layout-delta-y", "0px");
      }

      const cleanupTimer = window.setTimeout(() => {
        for (const item of movedItems) {
          delete item.dataset.layoutMotion;
          item.style.removeProperty("--list-layout-delta-y");
        }
        activeTimers.delete(container);
      }, MOTION_DURATION_MS.standard);
      activeTimers.set(container, [cleanupTimer]);
    });
    activeFrames.set(container, [playFrame]);
  });
  activeFrames.set(container, [measureFrame]);
}

export function cancelListLayoutMotion(container: Element | null) {
  if (!container) return;
  clearPending(container);
  container.querySelectorAll<HTMLElement>("[data-layout-motion-id]").forEach((item) => {
    delete item.dataset.layoutMotion;
    item.style.removeProperty("--list-layout-delta-y");
  });
}
