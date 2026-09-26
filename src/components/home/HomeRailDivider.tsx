import { useEffect, useRef, useState } from "react";

export function HomeRailDivider({ identity }: { identity: string }) {
  const key = `project-mind:home-rail-split:${identity}`;
  const [percent, setPercent] = useState(() => {
    try { const stored = Number(localStorage.getItem(key)); return stored >= 25 && stored <= 75 ? stored : 48; }
    catch { return 48; }
  });
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const update = (value: number) => setPercent(Math.max(25, Math.min(75, Math.round(value))));
  useEffect(() => {
    ref.current?.parentElement?.style.setProperty("--home-todo-share", `${percent}%`);
    try { localStorage.setItem(key, String(percent)); } catch { /* Keep resizing available without storage. */ }
  }, [percent, key]);
  return <div ref={ref} className="home-rail__divider" role="separator" aria-label="调整待办与文件区域高度" aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={75} aria-valuenow={percent} tabIndex={0}
    onPointerDown={(event) => { event.preventDefault(); dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={(event) => { const bounds = event.currentTarget.parentElement?.getBoundingClientRect(); if (dragging.current && bounds?.height) update((event.clientY - bounds.top) / bounds.height * 100); }}
    onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
    onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      update(event.key === "Home" ? 25 : event.key === "End" ? 75 : percent + (event.key === "ArrowUp" ? -5 : 5));
    }} />;
}
