import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import {
  FILE_TAG_COLOR_OPTIONS,
  tagColorLabel,
  tagColorValue,
} from "../../lib/constants";
import type { TagColorKey } from "../../lib/types";
import { PopoverPanel } from "../../ui/components";
import { cn } from "../../ui/lib/cn";

interface ColorKeyDropdownProps {
  value: TagColorKey;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  panelClassName?: string;
  ariaLabel?: string;
  onChange: (colorKey: TagColorKey) => void;
}

export function ColorKeyDropdown({
  value,
  disabled = false,
  size = "md",
  className,
  panelClassName,
  ariaLabel = "颜色",
  onChange,
}: ColorKeyDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <div ref={rootRef} className={cn("relative shrink-0", className)}>
      <button
        type="button"
        aria-label={`${ariaLabel} ${tagColorLabel(value)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-[var(--radius-6)] border bg-bg text-left text-text outline-none transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong disabled:pointer-events-none disabled:opacity-60",
          open ? "border-accent" : "border-border",
          size === "sm" ? "h-7 px-2.5 text-ui" : "h-8 px-3 text-body",
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn("shrink-0 rounded-full", size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3")}
            style={{ backgroundColor: tagColorValue(value) }}
            aria-hidden="true"
          />
          <span className="truncate">{tagColorLabel(value)}</span>
        </span>
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-text-soft transition-transform duration-[160ms] ease-[var(--ease-soft)]",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <PopoverPanel
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            "absolute left-0 top-[calc(100%+8px)] z-20 min-w-full p-1.5",
            panelClassName,
          )}
        >
          <div className="grid gap-1">
            {FILE_TAG_COLOR_OPTIONS.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[var(--radius-6)] px-2.5 py-2 text-left transition-colors",
                    size === "sm" ? "text-ui" : "text-body",
                    selected
                      ? "bg-bg-hover text-text"
                      : "text-text-muted hover:bg-bg-hover hover:text-text",
                  )}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tagColorValue(option.value) }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{tagColorLabel(option.value)}</span>
                </button>
              );
            })}
          </div>
        </PopoverPanel>
      ) : null}
    </div>
  );
}
