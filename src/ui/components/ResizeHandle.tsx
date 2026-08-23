import { useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "../lib/cn";

interface ResizeHandleProps {
  label: string;
  edge: "left" | "right";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  className?: string;
}

export function ResizeHandle({ label, edge, value, min, max, onChange, className }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const clamp = (next: number) => Math.max(min, Math.min(max, Math.round(next)));

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      onChange(clamp(edge === "right" ? moveEvent.clientX : window.innerWidth - moveEvent.clientX));
    };
    const handlePointerUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      data-resizing={dragging || undefined}
      className={cn("resize-handle", className)}
      onPointerDown={handlePointerDown}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 8;
        let next: number | null = null;
        if (event.key === "Home") next = min;
        if (event.key === "End") next = max;
        if (event.key === "ArrowLeft") next = value + (edge === "left" ? step : -step);
        if (event.key === "ArrowRight") next = value + (edge === "left" ? -step : step);
        if (next === null) return;
        event.preventDefault();
        onChange(clamp(next));
      }}
    />
  );
}
