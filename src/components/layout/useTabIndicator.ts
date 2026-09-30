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
      indicator.style.width = `${selected.offsetWidth}px`;
      indicator.style.left = `${selected.offsetLeft}px`;
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
    let listWidth = list.clientWidth;
    const observer = new ResizeObserver(() => {
      if (list.clientWidth !== listWidth) { listWidth = list.clientWidth; update(false); }
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, selection]);
  return indicatorRef;
}
