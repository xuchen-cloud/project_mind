import { createContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelRight } from "lucide-react";
import { IconButton } from "../../ui/components/IconButton";
import { ResizeHandle } from "../../ui/components/ResizeHandle";
import { TODO_RAIL_WIDTH_MAX_PX, TODO_RAIL_WIDTH_MIN_PX, useUiStore } from "../../state/ui-store";
import { MOTION_DURATION_MS } from "../../ui/motion";
import "./right-sidebar.css";

/** The shell owns visibility, so TodoRail stays mounted with its draft during dismissal. */
export const RightSidebarHostedContext = createContext(false);

export function RightSidebar({ children, showToggle = false }: { children: ReactNode; showToggle?: boolean }) {
  const { todoRailCollapsed, todoRailMode, todoRailWidthPx, setTodoRailCollapsed, setTodoRailWidthPx } = useUiStore();
  const open = !todoRailCollapsed;
  const [visited, setVisited] = useState(open);
  const surface = useRef<HTMLDivElement>(null);
  const internalEvents = useRef(new WeakSet<Event>());
  const previousBounds = useRef<DOMRect | null>(null);
  const previousMode = useRef(todoRailMode);
  const modeAnimation = useRef<Animation | null>(null);
  const restoreToggleFocus = useRef(false);

  useLayoutEffect(() => {
    if (!open && restoreToggleFocus.current) {
      restoreToggleFocus.current = false;
      document.querySelector<HTMLButtonElement>("[data-right-sidebar-toggle]")?.focus();
    }
  }, [open]);

  useEffect(() => { if (open) setVisited(true); }, [open]);
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    if (previousMode.current !== todoRailMode) modeAnimation.current?.cancel();
    const bounds = node.getBoundingClientRect();
    const before = previousBounds.current;
    if (open && before && previousMode.current !== todoRailMode
      && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      modeAnimation.current = node.animate?.([
        { transform: `translate(${before.left - bounds.left}px, ${before.top - bounds.top}px) scale(${before.width / bounds.width}, ${before.height / bounds.height})` },
        { transform: "none" },
      ], { duration: MOTION_DURATION_MS.deliberate, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }) ?? null;
    }
    previousBounds.current = bounds;
    previousMode.current = todoRailMode;
  }, [open, todoRailMode, todoRailWidthPx]);

  useEffect(() => () => modeAnimation.current?.cancel(), []);

  useEffect(() => {
    if (!open || todoRailMode === "pinned") return;
    const belongsToSidebar = (event: Event) => internalEvents.current.has(event)
      || (event.target instanceof Element && Boolean(event.target.closest("[data-right-sidebar-toggle]")));
    const dismiss = (event: Event) => {
      if (!belongsToSidebar(event)) setTodoRailCollapsed(true);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      restoreToggleFocus.current = true;
      setTodoRailCollapsed(true);
    };
    // React capture marks events from both descendants and their Portals before
    // native bubbling reaches document. A picker is still part of this sidebar.
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open, todoRailMode, setTodoRailCollapsed]);

  return <>
    {showToggle && !open ? <IconButton className="workspace-right-sidebar__toggle" data-right-sidebar-toggle
      aria-label="切换右侧栏" aria-expanded={false} onClick={() => setTodoRailCollapsed(false)}><PanelRight size={16} /></IconButton> : null}
    <section aria-label="右侧栏" aria-hidden={!open} inert={!open}
    className="workspace-right-sidebar" data-mode={todoRailMode} data-open={open}
    style={{ "--right-sidebar-width": `${todoRailWidthPx}px` } as CSSProperties}
    onClickCapture={() => { previousBounds.current = surface.current?.getBoundingClientRect() ?? null; }}
    onPointerDownCapture={event => internalEvents.current.add(event.nativeEvent)}
    onFocusCapture={event => internalEvents.current.add(event.nativeEvent)}>
    <div ref={surface} className="workspace-right-sidebar__surface">
      <ResizeHandle label="调整 Todo Rail 宽度" edge="left" value={todoRailWidthPx}
        min={TODO_RAIL_WIDTH_MIN_PX} max={TODO_RAIL_WIDTH_MAX_PX}
        onChange={setTodoRailWidthPx} className="workspace-right-sidebar__resize" />
      <RightSidebarHostedContext.Provider value>
        {visited || open ? children : null}
      </RightSidebarHostedContext.Provider>
    </div>
  </section>
  </>;
}
