import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "../lib/cn";
import { PopoverPanel } from "./PopoverPanel";

const MENU_WIDTH = 224;
const MENU_ITEM_HEIGHT = 38;
const MENU_SEPARATOR_HEIGHT = 9;
const MENU_VERTICAL_PADDING = 8;
const VIEWPORT_PADDING = 12;
const SUBMENU_GAP = 6;

export type ContextMenuAction =
  | {
      type?: "action";
      key?: string;
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      disabled?: boolean;
      tone?: "default" | "danger";
      shortcut?: string;
      group?: string;
    }
  | {
      type: "submenu";
      key?: string;
      label: string;
      icon?: LucideIcon;
      actions: ContextMenuAction[];
      disabled?: boolean;
    }
  | {
      type: "separator";
      key?: string;
    };

export function ActionContextMenu({
  x,
  y,
  actions,
  onClose,
  ariaLabel = "操作菜单",
  autoFocus = true,
}: {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
  ariaLabel?: string;
  autoFocus?: boolean;
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
    const menuHeight =
      actions.reduce(
        (total, action) =>
          total + (action.type === "separator" ? MENU_SEPARATOR_HEIGHT : MENU_ITEM_HEIGHT),
        MENU_VERTICAL_PADDING,
      ) + MENU_VERTICAL_PADDING;

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
        Math.max(VIEWPORT_PADDING, window.innerHeight - menuHeight - VIEWPORT_PADDING),
      ),
    };
  }, [actions, x, y]);

  return (
    <PopoverPanel
      ref={menuRef}
      className="context-menu__panel fixed z-[80] min-w-[15rem] p-1.5 outline-none"
      style={position}
    >
      <ActionContextMenuLevel
        actions={actions}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        onClose={onClose}
      />
    </PopoverPanel>
  );
}

function ActionContextMenuLevel({
  actions,
  ariaLabel,
  autoFocus = false,
  onClose,
}: {
  actions: ContextMenuAction[];
  ariaLabel?: string;
  autoFocus?: boolean;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);
  const [openSubmenuTop, setOpenSubmenuTop] = useState(0);

  useEffect(() => {
    if (autoFocus) {
      menuRef.current?.focus();
    }
  }, [actions, autoFocus]);

  const focusItem = (startIndex: number, direction: 1 | -1) => {
    const items = itemRefs.current;
    const itemCount = items.length;

    if (itemCount === 0) {
      return;
    }

    for (let offset = 1; offset <= itemCount; offset += 1) {
      const nextIndex = (startIndex + offset * direction + itemCount) % itemCount;
      const candidate = items[nextIndex];

      if (candidate && !candidate.disabled) {
        candidate.focus();
        return;
      }
    }
  };

  const openSubmenu = (index: number) => {
    const anchor = itemRefs.current[index];
    setOpenSubmenuIndex(index);
    setOpenSubmenuTop(anchor ? Math.max(0, anchor.offsetTop - MENU_VERTICAL_PADDING) : 0);
  };

  const activeSubmenu =
    openSubmenuIndex === null ? null : actions[openSubmenuIndex]?.type === "submenu"
      ? actions[openSubmenuIndex]
      : null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="context-menu__list relative grid gap-1 outline-none"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const activeIndex = itemRefs.current.findIndex((item) => item === document.activeElement);

        if (event.key === "ArrowDown") {
          event.preventDefault();
          focusItem(activeIndex < 0 ? -1 : activeIndex, 1);
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          focusItem(activeIndex < 0 ? 0 : activeIndex, -1);
          return;
        }

        if (event.key === "Home") {
          event.preventDefault();
          focusItem(-1, 1);
          return;
        }

        if (event.key === "End") {
          event.preventDefault();
          focusItem(0, -1);
          return;
        }

        if (event.key === "ArrowRight" && activeIndex >= 0) {
          const action = actions[activeIndex];
          if (action?.type === "submenu" && !action.disabled) {
            event.preventDefault();
            openSubmenu(activeIndex);
          }
        }
      }}
    >
      {actions.map((action, index) =>
        action.type === "separator" ? (
          <div
            key={action.key ?? `separator-${index}`}
            role="separator"
            className="my-1 h-px bg-[color-mix(in_srgb,var(--color-border)_84%,transparent)]"
          />
        ) : (
          <button
            key={action.key ?? action.label}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            type="button"
            role="menuitem"
            aria-haspopup={action.type === "submenu" ? "menu" : undefined}
            aria-expanded={action.type === "submenu" ? openSubmenuIndex === index : undefined}
            className={cn(
              "context-menu__item flex w-full items-center justify-between gap-3 rounded-[var(--radius-6)] px-2.5 py-2 text-left text-ui transition-colors outline-none",
              action.disabled
                ? "cursor-not-allowed text-text-soft"
                : "bg-transparent text-text-muted hover:bg-bg-hover hover:text-text focus-visible:bg-bg-hover focus-visible:text-text",
              action.type === "submenu" && openSubmenuIndex === index
                ? "bg-bg-hover text-text"
                : "",
              action.type !== "submenu" && action.tone === "danger"
                ? "text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)]"
                : "",
            )}
            disabled={action.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => {
              if (action.type === "submenu" && !action.disabled) {
                openSubmenu(index);
                return;
              }

              setOpenSubmenuIndex(null);
            }}
            onFocus={() => {
              if (action.type === "submenu" && !action.disabled) {
                openSubmenu(index);
                return;
              }

              setOpenSubmenuIndex(null);
            }}
            onClick={() => {
              if (action.type === "submenu") {
                if (!action.disabled) {
                  openSubmenu(index);
                }
                return;
              }

              onClose();
              action.onSelect();
            }}
          >
            {action.icon ? (
              <span className="shrink-0">
                <action.icon size={14} />
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
            {action.type === "submenu" ? (
              <span className="shrink-0 text-text-soft">
                <ChevronRight size={14} />
              </span>
            ) : action.shortcut ? (
              <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-text-soft">
                {action.shortcut}
              </span>
            ) : null}
          </button>
        ),
      )}
      {activeSubmenu ? (
        <div
          className="absolute z-[81]"
          style={{
            left: `calc(100% + ${SUBMENU_GAP}px)`,
            top: openSubmenuTop,
          }}
        >
          <PopoverPanel className="context-menu__submenu-panel min-w-[15rem] p-1.5">
            <ActionContextMenuLevel
              actions={activeSubmenu.actions}
              ariaLabel={`${activeSubmenu.label} 子菜单`}
              onClose={onClose}
            />
          </PopoverPanel>
        </div>
      ) : null}
    </div>
  );
}
