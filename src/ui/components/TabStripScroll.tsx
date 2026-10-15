import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import "./tab-strip-scroll.css";

export interface TabStripScrollProps {
  viewportRef: RefObject<HTMLDivElement | null>;
  /** Change when tabs or their content change, including replacement of the content wrapper. */
  contentKey: string;
  ariaLabel: string;
  /** Existing viewport ID, when the parent supplies one. */
  viewportId?: string;
}

const emptyMetrics = { width: 0, max: 0, position: 0, thumb: 0, travel: 0 };
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

/**
 * Render beside the existing viewport in a same-width `.tab-strip-frame`.
 * The parent owns overflow, tab layout and edge masks; this component only adds
 * an absolute bottom overlay and temporarily hides the viewport's native bar.
 */
export function TabStripScroll({ viewportRef, contentKey, ariaLabel, viewportId }: TabStripScrollProps) {
  const generatedId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; position: number } | null>(null);
  const metricsRef = useRef(emptyMetrics);
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [dragging, setDragging] = useState(false);
  const [resolvedViewportId, setResolvedViewportId] = useState("");

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    const track = trackRef.current;
    if (drag && track?.hasPointerCapture(drag.pointerId)) track.releasePointerCapture(drag.pointerId);
    setDragging(false);
  }, []);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const width = viewport.clientWidth;
    const max = Math.max(0, viewport.scrollWidth - width);
    const thumb = max > 0 && width > 0 ? Math.min(width, Math.max(20, width * width / viewport.scrollWidth)) : 0;
    const next = { width, max, position: clamp(viewport.scrollLeft, max), thumb, travel: width - thumb };
    metricsRef.current = next;
    setMetrics(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    if (!thumb) endDrag();
  }, [viewportRef, endDrag]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const hadClass = viewport.classList.contains("tab-strip-viewport");
    viewport.classList.add("tab-strip-viewport");
    const originalId = viewport.id;
    const id = viewportId || originalId || `tab-strip-viewport-${generatedId}`;
    viewport.id = id;
    setResolvedViewportId(id);
    measure();
    viewport.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    return () => {
      endDrag();
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
      if (!hadClass) viewport.classList.remove("tab-strip-viewport");
      if (viewport.id === id) {
        if (originalId) viewport.id = originalId;
        else viewport.removeAttribute("id");
      }
    };
  }, [viewportRef, contentKey, viewportId, generatedId, measure, endDrag]);

  function scrollTo(position: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = clamp(position, metricsRef.current.max);
    measure();
  }

  if (!metrics.thumb) return null;
  const offset = metrics.max > 0 ? metrics.position / metrics.max * metrics.travel : 0;

  return <div
    ref={trackRef}
    className="tab-strip-scroll"
    data-dragging={dragging || undefined}
    style={{ width: metrics.width }}
    role="scrollbar"
    tabIndex={0}
    aria-label={ariaLabel}
    aria-controls={resolvedViewportId}
    aria-orientation="horizontal"
    aria-valuemin={0}
    aria-valuemax={metrics.max}
    aria-valuenow={metrics.position}
    onKeyDown={event => {
      const positions: Record<string, number> = {
        ArrowLeft: metrics.position - 40,
        ArrowRight: metrics.position + 40,
        Home: 0,
        End: metrics.max,
      };
      if (!(event.key in positions)) return;
      event.preventDefault();
      scrollTo(positions[event.key]);
    }}
    onPointerDown={event => {
      if (event.button !== 0 || dragRef.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      if (event.target === thumbRef.current) {
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, position: metricsRef.current.position };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      } else if (metricsRef.current.travel > 0) {
        const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
        scrollTo((x - metricsRef.current.thumb / 2) / metricsRef.current.travel * metricsRef.current.max);
      }
    }}
    onPointerMove={event => {
      const drag = dragRef.current;
      const current = metricsRef.current;
      if (!drag || drag.pointerId !== event.pointerId || current.travel <= 0) return;
      scrollTo(drag.position + (event.clientX - drag.x) / current.travel * current.max);
    }}
    onPointerUp={event => { if (dragRef.current?.pointerId === event.pointerId) endDrag(); }}
    onPointerCancel={event => { if (dragRef.current?.pointerId === event.pointerId) endDrag(); }}
    onLostPointerCapture={event => { if (dragRef.current?.pointerId === event.pointerId) endDrag(); }}
  >
    <span ref={thumbRef} className="tab-strip-scroll__thumb" style={{ width: metrics.thumb, transform: `translateX(${offset}px)` }} />
  </div>;
}
