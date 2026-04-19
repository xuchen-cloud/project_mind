import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { colorKeyBadgeStyle, fileTagColorValue } from "../../lib/constants";
import type { FileTagColorKey } from "../../lib/types";
import type { StatusTone } from "../../ui/components";
import { Button, PopoverPanel } from "../../ui/components";
import { cn } from "../../ui/lib/cn";

interface ActivityTagDropdownOption {
  id: number;
  label: string;
  colorKey?: FileTagColorKey | null;
}

interface ActivityTagDropdownProps {
  label: string;
  tone?: StatusTone;
  colorKey?: FileTagColorKey | null;
  selectedOptionId?: number | null;
  options: ActivityTagDropdownOption[];
  manageLabel?: string;
  emptyText: string;
  busy?: boolean;
  clearLabel?: string;
  onSelect: (optionId: number) => void;
  onManage?: () => void;
  onClear?: () => void;
}

export function ActivityTagDropdown({
  label,
  tone = "neutral",
  colorKey = null,
  selectedOptionId = null,
  options,
  manageLabel,
  emptyText,
  busy = false,
  clearLabel,
  onSelect,
  onManage,
  onClear,
}: ActivityTagDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[var(--radius-4)] px-2 py-1 text-caption font-medium tracking-[0.08em] transition-[background-color,color,border-color] duration-[160ms] ease-[var(--ease-soft)] disabled:pointer-events-none disabled:opacity-60",
          colorKey
            ? "hover:opacity-90"
            : "",
          tone === "neutral" && !colorKey && "bg-bg-muted text-text-muted hover:bg-bg-hover hover:text-text",
          tone === "accent" &&
            !colorKey &&
            "bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-accent hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]",
          tone === "success" &&
            !colorKey &&
            "bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-success hover:bg-[color-mix(in_srgb,var(--color-success)_16%,transparent)]",
          tone === "warning" &&
            !colorKey &&
            "bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-warning hover:bg-[color-mix(in_srgb,var(--color-warning)_16%,transparent)]",
          tone === "danger" &&
            !colorKey &&
            "bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)]",
        )}
        style={colorKey ? colorKeyBadgeStyle(colorKey) : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 transition-transform duration-[160ms] ease-[var(--ease-soft)]",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <PopoverPanel className="absolute left-0 top-[calc(100%+8px)] z-20 min-w-[14rem] p-1.5">
          <div className="grid gap-1">
            {options.length > 0 ? (
              options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={cn(
                    "w-full rounded-[var(--radius-6)] px-2.5 py-2 text-left text-ui transition-colors",
                    option.id === selectedOptionId
                      ? "bg-bg-hover text-text"
                      : "bg-transparent text-text-muted hover:bg-bg-hover hover:text-text",
                  )}
                  onClick={() => {
                    onSelect(option.id);
                    setOpen(false);
                  }}
                >
                  <span className="flex items-center gap-2">
                    {option.colorKey ? (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: fileTagColorValue(option.colorKey) }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span>{option.label}</span>
                  </span>
                </button>
              ))
            ) : (
              <p className="px-2.5 py-2 text-ui text-text-soft">{emptyText}</p>
            )}

            {onClear ? (
              <button
                type="button"
                className="w-full rounded-[var(--radius-6)] px-2.5 py-2 text-left text-ui text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
              >
                {clearLabel}
              </button>
            ) : null}
          </div>

          {onManage && manageLabel ? (
            <div className="mt-1 border-t border-border pt-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full justify-start px-2.5"
                onClick={() => {
                  onManage();
                  setOpen(false);
                }}
              >
                {manageLabel}
              </Button>
            </div>
          ) : null}
        </PopoverPanel>
      ) : null}
    </div>
  );
}
