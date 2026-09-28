import { useEffect } from "react";

const textSelector = [
  ":is(aside, .home-side, .home-rail, .todo-rail) .truncate",
  ".home-side__item > span",
  ".home-side__workspace-tab",
  ".sidebar-dock__label",
  ".todo-rail__scope",
  ".todo-rail__group-title",
  ":is(aside, .home-side, .home-rail, .todo-rail) :is(.internal-reference-chip__label, .contact-mention-chip__label, .tag-mention-chip__label)",
].join(",");

/** Measure the text box, not its row, so adjacent action icons remain visible. */
export function useSidebarTextFade() {
  useEffect(() => {
    const observed = new Set<HTMLElement>();
    let frame = 0;
    const measure = (element: HTMLElement) => {
      element.dataset.sidebarText = "true";
      const overflowing = element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
      element.toggleAttribute("data-text-overflow", overflowing);
      if (!element.title || element.dataset.fadeTitle === "true") {
        element.title = overflowing ? element.textContent?.trim() ?? "" : "";
        element.dataset.fadeTitle = "true";
      }
    };
    const resize = new ResizeObserver((entries) => {
      entries.forEach(({ target }) => measure(target as HTMLElement));
    });
    const scan = () => {
      frame = 0;
      for (const element of observed) {
        if (!element.isConnected || !element.matches(textSelector)) {
          resize.unobserve(element);
          observed.delete(element);
        }
      }
      document.querySelectorAll<HTMLElement>(textSelector).forEach((element) => {
        if (!observed.has(element)) {
          observed.add(element);
          resize.observe(element);
        }
        measure(element);
      });
    };
    const mutation = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(scan);
    });
    mutation.observe(document.body, { childList: true, characterData: true, subtree: true });
    scan();
    document.fonts?.ready.then(() => { if (observed.size) scan(); });
    return () => {
      cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      observed.clear();
    };
  }, []);
}
