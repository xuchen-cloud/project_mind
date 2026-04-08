import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";

import type { TodoPriority } from "../../lib/types";
import { PopoverPanel } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { TodoPriorityBadge } from "./TodoPriorityBadge";
import { TODO_PRIORITY_OPTIONS, priorityOptionLabel } from "./todo-utils";

interface FloatingMenuPosition {
  left: number;
  top: number;
  width: number;
}

export function TodoPriorityDropdown({
  priority,
  onSelect,
}: {
  priority: TodoPriority;
  onSelect: (priority: TodoPriority) => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<FloatingMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return undefined;
    }

    const updatePosition = () => {
      if (!triggerRef.current) {
        return;
      }

      const viewportPadding = 12;
      const gap = 8;
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const menuHeight = menuRef.current?.offsetHeight ?? 0;
      const menuWidth = Math.max(menuRef.current?.offsetWidth ?? 0, 192);
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const shouldOpenUp =
        menuHeight > 0 &&
        spaceBelow < menuHeight + gap + viewportPadding &&
        triggerRect.top > spaceBelow;

      const top = shouldOpenUp
        ? Math.max(viewportPadding, triggerRect.top - menuHeight - gap)
        : Math.max(
            viewportPadding,
            Math.min(
              triggerRect.bottom + gap,
              window.innerHeight - menuHeight - viewportPadding,
            ),
          );
      const left = Math.max(
        viewportPadding,
        Math.min(triggerRect.left, window.innerWidth - menuWidth - viewportPadding),
      );

      setMenuPosition({
        left,
        top,
        width: Math.max(triggerRect.width, 192),
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  async function handleSelect(nextPriority: TodoPriority) {
    if (nextPriority === priority) {
      setOpen(false);
      return;
    }

    setBusy(true);
    try {
      await onSelect(nextPriority);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-[var(--radius-6)] bg-transparent p-0 transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
        aria-label={`修改优先级：${priorityOptionLabel(priority)}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <TodoPriorityBadge priority={priority} />
        <ChevronDown
          size={13}
          className={cn(
            "shrink-0 text-text-soft transition-transform duration-[160ms] ease-[var(--ease-soft)]",
            open && "rotate-180",
          )}
        />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="z-[120]"
              style={{
                position: "fixed",
                left: menuPosition?.left ?? 0,
                top: menuPosition?.top ?? 0,
                width: menuPosition?.width ?? 192,
                visibility: menuPosition ? "visible" : "hidden",
              }}
            >
              <PopoverPanel className="min-w-[12rem] p-1.5">
                <div className="grid gap-1">
                  {TODO_PRIORITY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={option.value === priority}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-[var(--radius-6)] px-2.5 py-2 text-left text-ui transition-colors",
                        option.value === priority
                          ? "bg-bg-hover text-text"
                          : "bg-transparent text-text-muted hover:bg-bg-hover hover:text-text",
                      )}
                      onClick={() => {
                        void handleSelect(option.value);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-flex min-w-[2rem] items-center justify-center rounded-full border px-1.5 py-0.5 text-caption font-medium tracking-[0.12em]"
                          style={{
                            borderColor: `color-mix(in srgb, ${option.colorValue} 22%, var(--color-border))`,
                            backgroundColor: `color-mix(in srgb, ${option.colorValue} 9%, var(--color-bg))`,
                            color: option.colorValue,
                          }}
                        >
                          {option.code}
                        </span>
                        <span>{option.label}</span>
                      </span>
                      {option.value === priority ? <Check size={14} className="shrink-0" /> : null}
                    </button>
                  ))}
                </div>
              </PopoverPanel>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
