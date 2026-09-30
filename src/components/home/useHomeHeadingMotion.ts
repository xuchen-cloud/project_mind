import { useEffect, useState, type RefObject } from "react";

/** Shared scroll-driven cover-to-dock transition for overview and record pages. */
export function useHomeHeadingMotion(sectionRef: RefObject<HTMLElement | null>, identity: string, title?: string, expanded = false, topInset = 0) {
  const [titleVisible, setTitleVisible] = useState(false);
  useEffect(() => {
    const section = sectionRef.current;
    const scroller = section?.closest(".project-overview-focus__scroll");
    const coverTitle = scroller?.querySelector<HTMLElement>(".home-cover__identity");
    const heading = section?.querySelector<HTMLElement>(".home-quick-note__page-heading");
    if (!section || !scroller || !coverTitle || !heading || !title) return;
    const cover = coverTitle.closest<HTMLElement>(".home-cover");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => {
      const shell = section.closest(".home-window-shell");
      const toolbarHeight = shell ? parseFloat(getComputedStyle(shell).getPropertyValue("--home-toolbar-height")) || 0 : 0;
      const gap = shell ? parseFloat(getComputedStyle(shell).getPropertyValue("--home-sticky-gap")) || 8 : 8;
      const source = coverTitle.getBoundingClientRect();
      if (source.width === 0 && section.clientWidth === 0) return;
      const targetY = scroller.getBoundingClientRect().top + toolbarHeight + gap + topInset;
      const collapseDistance = 32;
      const progress = Math.max(0, Math.min(1, (targetY + collapseDistance - source.top) / collapseDistance));
      const active = progress > 0;
      // Measure the untransformed slot; the visible title follows the scroll gesture directly.
      const targetX = section.getBoundingClientRect().left;
      const slotY = section.getBoundingClientRect().top - 30;
      const sourceFont = parseFloat(getComputedStyle(coverTitle.querySelector(".home-cover__title") ?? coverTitle).fontSize) || 28;
      const scale = reducedMotion?.matches ? 1 : 1 + (sourceFont / 18 - 1) * (1 - progress);
      const y = reducedMotion?.matches ? targetY : source.top + (targetY - source.top) * progress;
      const x = reducedMotion?.matches ? targetX : source.left + (targetX - source.left) * progress;
      heading.style.setProperty("--heading-scale", String(scale));
      heading.style.transform = `translate(${x - targetX}px, ${y - slotY}px) scale(${scale})`;
      heading.style.width = `${section.clientWidth / scale}px`;
      coverTitle.style.visibility = active ? "hidden" : "";
      setTitleVisible(active);
      // Fade the complete scenery, not a rectangular slice behind the docked title.
      const blend = progress * progress * (3 - 2 * progress);
      section.style.setProperty("--heading-backdrop-opacity", String(blend));
      cover?.style.setProperty("--cover-scenery-opacity", String(1 - blend));
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    reducedMotion?.addEventListener("change", update);
    return () => {
      coverTitle.style.visibility = "";
      cover?.style.removeProperty("--cover-scenery-opacity");
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      reducedMotion?.removeEventListener("change", update);
    };
  }, [identity, title, expanded, topInset]);
  return titleVisible;
}
