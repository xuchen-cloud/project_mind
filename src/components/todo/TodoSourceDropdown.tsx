import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";

import { PopoverPanel } from "../../ui/components";
import { cn } from "../../ui/lib/cn";

interface FloatingMenuPosition {
  left: number;
  top: number;
  width: number;
}

export function TodoSourceDropdown({
  activityId,
  activityOptions,
  onSelect,
}: {
  activityId: number | null;
  activityOptions: Array<{ id: number; title: string }>;
  onSelect: (activityId: number | null) => Promise<unknown> | void;
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
      const menuWidth = Math.max(menuRef.current?.offsetWidth ?? 0, 208);
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
        Math.min(triggerRect.left - 8, window.innerWidth - menuWidth - viewportPadding),
      );

      setMenuPosition({
        left,
        top,
        width: Math.max(menuWidth, 208),
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

  async function handleSelect(nextActivityId: number | null) {
    if (nextActivityId === activityId) {
      setOpen(false);
      return;
    }

    setBusy(true);
    try {
      await onSelect(nextActivityId);
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
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-transparent text-text-soft transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-60"
        aria-label="修改归属 Activity"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <ChevronDown
          size={12}
          className={cn(
            "transition-transform duration-[160ms] ease-[var(--ease-soft)]",
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
                width: menuPosition?.width ?? 208,
                visibility: menuPosition ? "visible" : "hidden",
              }}
            >
              <PopoverPanel className="min-w-[13rem] p-1.5">
                <div className="grid gap-1" role="menu" aria-label="选择归属 Activity">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={activityId === null}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-[var(--radius-6)] px-2.5 py-2 text-left text-ui transition-colors",
                      activityId === null
                        ? "bg-bg-hover text-text"
                        : "bg-transparent text-text-muted hover:bg-bg-hover hover:text-text",
                    )}
                    onClick={() => {
                      void handleSelect(null);
                    }}
                  >
                    <span>项目级 Todo</span>
                    {activityId === null ? <Check size={14} className="shrink-0" /> : null}
                  </button>
                  {activityOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={activityId === option.id}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-[var(--radius-6)] px-2.5 py-2 text-left text-ui transition-colors",
                        activityId === option.id
                          ? "bg-bg-hover text-text"
                          : "bg-transparent text-text-muted hover:bg-bg-hover hover:text-text",
                      )}
                      onClick={() => {
                        void handleSelect(option.id);
                      }}
                    >
                      <span className="truncate">{option.title}</span>
                      {activityId === option.id ? (
                        <Check size={14} className="shrink-0" />
                      ) : null}
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
