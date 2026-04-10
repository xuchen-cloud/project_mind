import { useEffect, useMemo, useRef } from "react";

import { cn } from "../lib/cn";

const MENU_WIDTH = 168;
const MENU_HEIGHT = 52;
const VIEWPORT_PADDING = 12;

export function DeleteContextMenu({
  x,
  y,
  onDelete,
  onClose,
  ariaLabel = "删除菜单",
  deleteLabel = "删除",
  disabled = false,
}: {
  x: number;
  y: number;
  onDelete: () => void;
  onClose: () => void;
  ariaLabel?: string;
  deleteLabel?: string;
  disabled?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const position = useMemo(() => {
    if (typeof window === "undefined") {
      return { left: x, top: y };
    }

    return {
      left: Math.min(
        Math.max(VIEWPORT_PADDING, x),
        Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING),
      ),
      top: Math.min(
        Math.max(VIEWPORT_PADDING, y),
        Math.max(VIEWPORT_PADDING, window.innerHeight - MENU_HEIGHT - VIEWPORT_PADDING),
      ),
    };
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className="fixed z-[80] min-w-[9rem] rounded-[var(--radius-8)] border border-border bg-bg p-1 shadow-[var(--shadow-md)]"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className={cn(
          "w-full rounded-[var(--radius-6)] px-2 py-2 text-left text-ui transition-colors",
          disabled
            ? "cursor-not-allowed text-text-soft"
            : "text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)]",
        )}
        disabled={disabled}
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        {deleteLabel}
      </button>
    </div>
  );
}
