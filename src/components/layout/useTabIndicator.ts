import { useLayoutEffect, useRef, type RefObject } from "react";

/** Move only the decorative surface; tab contents and hit targets stay stationary. */
export function useTabIndicator(listRef: RefObject<HTMLDivElement | null>, selection: string) {
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const initialized = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    const indicator = indicatorRef.current;
    if (!list || !indicator) return;
    const update = (animate: boolean) => {
      const selected = list.querySelector<HTMLElement>('.workspace-topbar__tab--active');
      if (!selected) { indicator.style.opacity = "0"; initialized.current = false; return; }
      const previous = initialized.current ? indicator.getBoundingClientRect() : null;
      indicator.getAnimations?.().forEach(animation => animation.cancel());
      const bounds = selected.getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      indicator.style.width = `${bounds.width}px`;
      indicator.style.left = `${bounds.left - listBounds.left}px`;
      const viewport = selected.closest<HTMLElement>(".workspace-topbar__tab-scroll");
      if (viewport) {
        const clip = viewport.getBoundingClientRect();
        // At either scroll boundary the terminal Tab's shoulder joins the page
        // outside the viewport; scrolling content still clips at the live edge.
        const left = clip.left - (viewport.scrollLeft <= 0 ? 10 : 0);
        const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        const right = clip.right + (viewport.scrollLeft >= maxScroll ? 10 : 0);
        indicator.style.clipPath = `inset(0 ${Math.max(-10, bounds.right - right)}px 0 ${Math.max(-10, left - bounds.left)}px)`;
      } else {
        indicator.style.clipPath = "none";
      }
      indicator.style.opacity = "1";
      const next = indicator.getBoundingClientRect();
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      if (animate && previous && next.width && !reduced && indicator.animate) {
        indicator.animate([
          { transform: `translateX(${previous.left - next.left}px) scaleX(${previous.width / next.width})` },
          { transform: 'translateX(0) scaleX(1)' },
        ], { duration: 180, easing: getComputedStyle(list).getPropertyValue('--ease-out').trim() || 'ease-out' });
      }
      initialized.current = true;
    };
    update(true);
    const refresh = () => update(false);
    list.addEventListener("scroll", refresh, true);
    const selected = list.querySelector<HTMLElement>('.workspace-topbar__tab--active');
    const viewport = list.querySelector<HTMLElement>(".workspace-topbar__tab-scroll");
    const widths = () => [list.clientWidth, selected?.offsetWidth, viewport?.clientWidth].join(":");
    let measuredWidths = widths();
    const observer = new ResizeObserver(() => {
      const nextWidths = widths();
      if (nextWidths === measuredWidths) return;
      measuredWidths = nextWidths;
      update(false);
    });
    observer.observe(list);
    if (selected) observer.observe(selected);
    if (viewport) observer.observe(viewport);
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", refresh, true);
    };
  }, [listRef, selection]);
  return indicatorRef;
}
