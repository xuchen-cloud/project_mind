import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Escape card/scroll clipping and keep the menu inside the viewport. */
export function AnchoredPicker({ anchorRef, children }: {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const gap = 6;
      const edge = 8;
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - edge);
      const above = Math.max(0, rect.top - gap - edge);
      const height = panel.scrollHeight;
      const up = height > below && above > below;
      panel.style.maxHeight = `${up ? above : below}px`;
      panel.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - panel.offsetWidth - edge))}px`;
      panel.style.top = `${Math.max(edge, up ? rect.top - gap - Math.min(height, above) : rect.bottom + gap)}px`;
      panel.style.visibility = rect.bottom < 0 || rect.top >= window.innerHeight ? "hidden" : "visible";
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    observer.observe(panel);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);
  return createPortal(<div ref={panelRef} data-anchored-picker="" style={{
    position: "fixed", zIndex: 120, maxWidth: "calc(100vw - 16px)",
    overflowY: "auto", overflowX: "hidden",
  }}>{children}</div>, document.body);
}
