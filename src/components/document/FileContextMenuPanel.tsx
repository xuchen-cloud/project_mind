import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PopoverPanel } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "./file-context-menu.css";

const PADDING = 12;

/** File actions keep viewport coordinates even inside transformed sidebars. */
export function FileContextMenuPanel({ x, y, menuRef, children }: {
  x: number; y: number; menuRef: RefObject<HTMLDivElement | null>; children: ReactNode;
}) {
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const panel = menuRef.current;
    if (!panel) return;
    const measure = () => {
      const { width, height } = panel.getBoundingClientRect();
      const left = Math.max(PADDING, Math.min(x, window.innerWidth - width - PADDING));
      const top = Math.max(PADDING, Math.min(y, window.innerHeight - height - PADDING));
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [x, y, menuRef]);
  return createPortal(<PopoverPanel ref={menuRef}
    className="context-menu__panel file-context-menu__panel fixed z-[80] flex w-[15rem] max-w-[calc(100vw-24px)] flex-col p-1"
    style={{ ...position, maxHeight: "calc(100vh - 24px)" }} role="menu" aria-label="文件操作"
    data-document-interactive="true" onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
    <HomeSidebarList label="文件操作列表">{children}</HomeSidebarList>
  </PopoverPanel>, document.body);
}
