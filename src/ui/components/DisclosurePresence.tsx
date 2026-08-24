import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { useMotionPresence } from "../../hooks/useMotionPresence";
import { commitListLayoutChange } from "../listLayoutMotion";

export function DisclosurePresence({
  open,
  triggerRef,
  className,
  children,
}: {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const presence = useMotionPresence(open, {
    commitExit: (update) => {
      const list = triggerRef.current?.closest("[data-disclosure-list]") ?? null;
      commitListLayoutChange(list, update);
    },
  });
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open && document.activeElement instanceof Node) {
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    }
  }, [open, triggerRef]);

  if (!presence.mounted) return null;

  return (
    <div
      ref={panelRef}
      className={`disclosure-presence${className ? ` ${className}` : ""}`}
      data-state={presence.state}
      aria-hidden={!open || undefined}
      inert={!open ? true : undefined}
      onTransitionEnd={presence.onTransitionEnd}
    >
      {children}
    </div>
  );
}
