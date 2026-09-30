import { useSearchResultsMotion } from "../../hooks/useSearchResultsMotion";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

/** Fade only the edges with off-screen content; headings stay outside the mask. */
export function HomeSidebarList({ label, children, searchKey, scrollRef, variant = "sidebar" }: {
  label: string;
  children: ReactNode;
  searchKey?: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
  variant?: "sidebar" | "todo";
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useSearchResultsMotion(content, searchKey);
  const [edges, setEdges] = useState({ top: 0, bottom: 0 });
  function measure() {
    const node = viewport.current;
    if (!node) return;
    const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
    const position = Math.max(0, Math.min(maxScroll, node.scrollTop));
    // Short lists must still reach a fully opaque edge fade. A fixed 64px
    // denominator made a 24px overflow permanently look almost unmasked.
    const fadeDistance = Math.min(64, maxScroll / 2);
    const top = fadeDistance > 0 ? Math.min(1, position / fadeDistance) : 0;
    const bottom = fadeDistance > 0 ? Math.min(1, (maxScroll - position) / fadeDistance) : 0;
    setEdges((previous) => previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
  }
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(measure, [children]);

  return <div style={{ "--scroll-fade-top-opacity": edges.top, "--scroll-fade-bottom-opacity": edges.bottom } as CSSProperties} className={`home-side__list-frame${variant === "todo" ? " todo-rail__list-frame" : ""}`} data-overflow-top={edges.top > 0 || undefined} data-overflow-bottom={edges.bottom > 0 || undefined}>
    <div ref={node => { viewport.current = node; if (scrollRef) scrollRef.current = node; }} className={`home-side__list${variant === "todo" ? " todo-rail__list-scroll" : ""}`} role="region" aria-label={label}
    data-overflow-top={edges.top > 0 || undefined} data-overflow-bottom={edges.bottom > 0 || undefined} onScroll={measure}>
    <div ref={content}>{children}</div>
    </div>
  </div>;
}
