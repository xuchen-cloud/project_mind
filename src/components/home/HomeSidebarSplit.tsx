import { useRef, useState, type ReactNode } from "react";

const clamp = (value: number) => Math.min(80, Math.max(20, value));

/** Two independent lists with fixed headers and a keyboard-accessible divider. */
export function HomeSidebarSplit({ storageKey, upper, lower }: {
  storageKey: string;
  upper: ReactNode;
  lower: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; ratio: number; height: number } | null>(null);
  const [ratio, setRatio] = useState(() => {
    try {
      const value = Number(localStorage.getItem(storageKey) ?? 50);
      return Number.isFinite(value) ? clamp(value) : 50;
    } catch { return 50; }
  });
  const [dragging, setDragging] = useState(false);
  function update(value: number) {
    const next = clamp(value);
    setRatio(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* Layout remains usable without storage. */ }
  }
  function stop() { drag.current = null; setDragging(false); }
  return <div ref={container} className="home-side__scroll home-side__split" style={{ gridTemplateRows: `minmax(96px, ${ratio}fr) 16px minmax(var(--home-sidebar-lower-min-height, 64px), ${100 - ratio}fr)` }}>
    <section className="home-side__section">{upper}</section>
    <div role="separator" aria-label="调整列表区域比例" aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio)} tabIndex={0}
      className="home-side__split-handle" data-resizing={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, ratio, height: Math.max(1, (container.current?.clientHeight ?? 1) - 16) };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start) update(start.ratio + (event.clientY - start.y) / start.height * 100);
      }}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 2;
        const next = event.key === "ArrowUp" ? ratio - step : event.key === "ArrowDown" ? ratio + step : event.key === "Home" ? 20 : event.key === "End" ? 80 : null;
        if (next !== null) { event.preventDefault(); update(next); }
      }}
    />
    <section className="home-side__section">{lower}</section>
  </div>;
}
