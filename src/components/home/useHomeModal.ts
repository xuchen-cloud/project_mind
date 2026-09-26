import { useEffect, useRef, type RefObject } from "react";

/** Keeps the editor mounted while its surrounding panel becomes modal. */
export function useHomeModal(open: boolean, panelRef: RefObject<HTMLDivElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [contenteditable="true"], [tabindex="0"]';
    const controls = () => Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter((element) => !element.hidden && !element.closest('[inert]'));
    const background: Array<[HTMLElement, boolean]> = [];
    let branch: HTMLElement = panel;
    while (branch.parentElement && branch.parentElement !== document.body) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling instanceof HTMLElement && sibling !== branch && !sibling.classList.contains("home-quick-note__backdrop")) {
          background.push([sibling, sibling.hasAttribute("inert")]);
          sibling.setAttribute("inert", "");
        }
      }
      branch = branch.parentElement;
    }
    controls()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const [element, inert] of background) if (!inert) element.removeAttribute("inert");
      if (previous?.isConnected) previous.focus();
    };
  }, [open, panelRef]);
}
