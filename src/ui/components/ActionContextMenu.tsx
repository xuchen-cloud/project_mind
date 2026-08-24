import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "../lib/cn";
import { PopoverPanel } from "./PopoverPanel";

const MENU_WIDTH = 176;
const MENU_ITEM_HEIGHT = 28;
const MENU_QUICK_ACTIONS_HEIGHT = 26;
const MENU_INLINE_ACTION_ROW_HEIGHT = 32;
const MENU_GRID_ACTION_ROW_HEIGHT = 26;
const MENU_SECTION_LABEL_HEIGHT = 20;
const MENU_SEPARATOR_HEIGHT = 4;
const MENU_VERTICAL_PADDING = 4;
const VIEWPORT_PADDING = 12;
const SUBMENU_GAP = 5;
const DEFAULT_INLINE_COLUMNS = 5;
const DEFAULT_GRID_COLUMNS = 2;
const MENU_ICON_SIZE = 12;

export interface ContextMenuInlineAction {
  key: string;
  label: string;
  icon?: LucideIcon;
  glyph?: string;
  active?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  swatch?: {
    color: string;
    shape?: "dot" | "pill";
  };
  onSelect: () => void;
}

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
      selected?: boolean;
      featured?: boolean;
    }
  | {
      type: "submenu";
      key?: string;
      label: string;
      icon?: LucideIcon;
      actions: ContextMenuAction[];
      disabled?: boolean;
      selected?: boolean;
      featured?: boolean;
    }
  | {
      type: "separator";
      key?: string;
    }
  | {
      type: "inline-actions";
      key?: string;
      actions: ContextMenuInlineAction[];
      ariaLabel?: string;
      columns?: number;
      showLabels?: boolean;
    }
  | {
      type: "quick-actions";
      key?: string;
      actions: ContextMenuInlineAction[];
      ariaLabel?: string;
    }
  | {
      type: "grid-actions";
      key?: string;
      title?: string;
      actions: ContextMenuInlineAction[];
      ariaLabel?: string;
      columns?: number;
    }
  | {
      type: "scroll-actions";
      key?: string;
      actions: Extract<ContextMenuAction, { type?: "action" }>[];
      ariaLabel?: string;
      maxVisibleItems?: number;
    }
  | {
      type: "section-label";
      key?: string;
      label: string;
      icon?: LucideIcon;
      trailingIcon?: LucideIcon;
      trailingLabel?: string;
      trailingDisabled?: boolean;
      onTrailingSelect?: () => void;
    };

function isActionButton(
  action: ContextMenuAction,
): action is Extract<ContextMenuAction, { type?: "action" } | { type: "submenu" }> {
  return (
    action.type !== "separator" &&
    action.type !== "inline-actions" &&
    action.type !== "quick-actions" &&
    action.type !== "grid-actions" &&
    action.type !== "scroll-actions" &&
    action.type !== "section-label"
  );
}

function isActionWithTone(
  action: ContextMenuAction,
): action is Extract<ContextMenuAction, { type?: "action" }> {
  return action.type === undefined || action.type === "action";
}

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

    const handleScroll = (event: Event) => {
      if (menuRef.current && event.composedPath().includes(menuRef.current)) {
        return;
      }

      onClose();
    };

    const handleClose = () => {
      onClose();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleClose);
    window.addEventListener("blur", handleClose);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("blur", handleClose);
    };
  }, [onClose]);

  const position = useMemo(() => {
    const menuHeight =
      actions.reduce(
        (total, action) => total + getActionHeight(action),
        MENU_VERTICAL_PADDING,
      ) + MENU_VERTICAL_PADDING;

    if (typeof window === "undefined") {
      return { left: x, top: y, menuHeight };
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
      menuHeight,
    };
  }, [actions, x, y]);

  return (
    <PopoverPanel
      ref={menuRef}
      className="context-menu__panel fixed z-[80] w-[11rem] rounded-[8px] border p-1 outline-none backdrop-blur-[18px]"
      style={{
        left: position.left,
        top: position.top,
        transformOrigin: `${Math.min(MENU_WIDTH, Math.max(0, x - position.left))}px ${Math.min(position.menuHeight, Math.max(0, y - position.top))}px`,
      }}
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
  const [openSubmenuSide, setOpenSubmenuSide] = useState<"left" | "right">("right");

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
    const menuRect = menuRef.current?.getBoundingClientRect();
    const anchorRect = anchor?.getBoundingClientRect();
    const nextSubmenu = actions[index]?.type === "submenu" ? actions[index] : null;
    const submenuHeight = nextSubmenu
      ? nextSubmenu.actions.reduce(
          (total, action) => total + getActionHeight(action),
          MENU_VERTICAL_PADDING,
        ) + MENU_VERTICAL_PADDING
      : 0;
    const submenuWidth = MENU_WIDTH;
    const spaceRight =
      typeof window === "undefined" || !anchorRect
        ? Number.POSITIVE_INFINITY
        : window.innerWidth - anchorRect.right - SUBMENU_GAP - VIEWPORT_PADDING;
    const spaceLeft =
      typeof window === "undefined" || !anchorRect
        ? 0
        : anchorRect.left - SUBMENU_GAP - VIEWPORT_PADDING;
    const shouldOpenLeft = spaceRight < submenuWidth && spaceLeft >= submenuWidth;
    const rawTop = anchor ? anchor.offsetTop - MENU_VERTICAL_PADDING : 0;
    const viewportTop = menuRect ? menuRect.top + rawTop : rawTop;
    const overflowBottom =
      typeof window === "undefined"
        ? 0
        : Math.max(0, viewportTop + submenuHeight - (window.innerHeight - VIEWPORT_PADDING));
    const overflowTop = menuRect
      ? Math.max(0, VIEWPORT_PADDING - (viewportTop - overflowBottom))
      : 0;

    setOpenSubmenuIndex(index);
    setOpenSubmenuSide(shouldOpenLeft ? "left" : "right");
    setOpenSubmenuTop(Math.max(
      menuRect ? VIEWPORT_PADDING - menuRect.top : 0,
      rawTop - overflowBottom + overflowTop,
    ));
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
      className="context-menu__list relative grid gap-0.5 outline-none"
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
      {actions.map((action, index) => {
        if (action.type === "separator") {
          return (
            <div
              key={action.key ?? `separator-${index}`}
              role="separator"
              className="my-0.5 h-px bg-[color-mix(in_srgb,var(--color-border)_88%,transparent)]"
            />
          );
        }

        if (action.type === "section-label") {
          return (
            <div
              key={action.key ?? `section-label-${index}`}
              className="context-menu__section-label flex min-h-5 items-center gap-1.5 px-1.5 text-[11px] font-medium text-text-soft"
              onMouseEnter={() => setOpenSubmenuIndex(null)}
            >
              {action.icon ? (
                <span className="flex w-3.5 shrink-0 items-center justify-center">
                  <action.icon size={MENU_ICON_SIZE} />
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.trailingIcon ? (
                <button
                  type="button"
                  className="context-menu__section-label-action flex h-5 w-5 items-center justify-center rounded-[5px] text-text-soft outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:bg-bg-hover focus-visible:text-text disabled:cursor-not-allowed disabled:text-text-disabled"
                  aria-label={action.trailingLabel ?? action.label}
                  title={action.trailingLabel ?? action.label}
                  disabled={action.trailingDisabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (action.trailingDisabled) {
                      return;
                    }
                    action.onTrailingSelect?.();
                  }}
                >
                  <action.trailingIcon size={MENU_ICON_SIZE} />
                </button>
              ) : null}
            </div>
          );
        }

        if (action.type === "quick-actions") {
          return (
            <div
              key={action.key ?? `quick-actions-${index}`}
              role="group"
              aria-label={action.ariaLabel ?? "快捷操作"}
              className="context-menu__quick-actions grid gap-0.5"
              style={{ gridTemplateColumns: `repeat(${Math.max(action.actions.length, 1)}, minmax(0, 1fr))` }}
              onMouseEnter={() => setOpenSubmenuIndex(null)}
            >
              {action.actions.map((inlineAction) => (
                <button
                  key={inlineAction.key}
                  type="button"
                  className={cn(
                    "context-menu__quick-action flex h-[1.375rem] items-center justify-center gap-0.5 rounded-[5px] px-1 text-[11px] text-text-muted outline-none transition-colors",
                    inlineAction.disabled
                      ? "cursor-not-allowed text-text-disabled"
                      : "hover:bg-bg-hover hover:text-text focus-visible:bg-bg-hover focus-visible:text-text",
                    inlineAction.active ? "bg-bg-muted text-text" : "",
                  )}
                  disabled={inlineAction.disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (inlineAction.disabled) {
                      return;
                    }
                    onClose();
                    inlineAction.onSelect();
                  }}
                >
                  {inlineAction.icon ? <inlineAction.icon size={MENU_ICON_SIZE} /> : null}
                  {inlineAction.glyph ? <span aria-hidden="true">{inlineAction.glyph}</span> : null}
                  <span className="truncate">{inlineAction.label}</span>
                </button>
              ))}
            </div>
          );
        }

        if (action.type === "inline-actions") {
          const columns = action.columns ?? DEFAULT_INLINE_COLUMNS;
          return (
            <div
              key={action.key ?? `inline-actions-${index}`}
              role="group"
              aria-label={action.ariaLabel ?? "格式操作"}
              className="context-menu__inline-actions grid gap-0.5 px-0.5"
              style={{ gridTemplateColumns: `repeat(${Math.max(columns, 1)}, minmax(0, 1fr))` }}
              onMouseEnter={() => setOpenSubmenuIndex(null)}
            >
              {action.actions.map((inlineAction) => (
                <button
                  key={inlineAction.key}
                  type="button"
                  aria-label={inlineAction.label}
                  title={inlineAction.label}
                  disabled={inlineAction.disabled}
                  className={cn(
                    "context-menu__inline-action flex aspect-square w-full min-w-0 items-center justify-center rounded-[5px] border border-transparent bg-transparent p-0 text-text-muted transition-colors outline-none",
                    inlineAction.swatch ? "px-2" : "",
                    inlineAction.disabled
                      ? "cursor-not-allowed text-text-soft"
                      : "hover:bg-bg-hover hover:text-text focus-visible:bg-bg-hover focus-visible:text-text",
                    inlineAction.active
                      ? "border-border bg-bg-muted text-text"
                      : "",
                  )}
                  style={inlineAction.style}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (inlineAction.disabled) {
                      return;
                    }

                    onClose();
                    inlineAction.onSelect();
                  }}
                >
                  {inlineAction.swatch ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block shrink-0 shadow-[inset_0_1px_0_color-mix(in_srgb,white_28%,transparent),0_0_0_1px_color-mix(in_srgb,var(--swatch-color)_18%,transparent)]",
                        inlineAction.swatch.shape === "dot"
                          ? "h-3 w-3 rounded-full"
                          : "h-3 w-full rounded-full",
                      )}
                      style={
                        {
                          "--swatch-color": inlineAction.swatch.color,
                          background:
                            "linear-gradient(180deg, color-mix(in srgb, var(--swatch-color) 88%, white 12%) 0%, var(--swatch-color) 100%)",
                        } as CSSProperties
                      }
                    />
                  ) : inlineAction.icon ? (
                    <inlineAction.icon size={MENU_ICON_SIZE} />
                  ) : inlineAction.glyph ? (
                    <span className="text-[11px] font-semibold leading-none" aria-hidden="true">
                      {inlineAction.glyph}
                    </span>
                  ) : null}
                  {action.showLabels ? (
                    <span className="w-full truncate text-center text-[11px] leading-none">
                      {inlineAction.label}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          );
        }

        if (action.type === "grid-actions") {
          const columns = action.columns ?? DEFAULT_GRID_COLUMNS;
          return (
            <div
              key={action.key ?? `grid-actions-${index}`}
              role="group"
              aria-label={action.ariaLabel ?? action.title ?? "网格操作"}
              className="context-menu__grid-actions grid gap-0.5"
              onMouseEnter={() => setOpenSubmenuIndex(null)}
            >
              {action.title ? (
                <div className="px-1.5 pb-0.5 pt-0.5 text-[11px] font-medium text-text-soft">
                  {action.title}
                </div>
              ) : null}
              <div
                className="grid gap-0.5"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(columns, 1)}, minmax(0, 1fr))`,
                }}
              >
                {action.actions.map((gridAction) => (
                  <button
                    key={gridAction.key}
                    type="button"
                    className={cn(
                      "context-menu__grid-action flex h-[1.625rem] min-w-0 items-center gap-1 rounded-[5px] px-1.5 text-left text-[11px] text-text-muted outline-none transition-colors",
                      gridAction.disabled
                        ? "cursor-not-allowed text-text-disabled"
                        : "hover:bg-bg-hover hover:text-text focus-visible:bg-bg-hover focus-visible:text-text",
                      gridAction.active ? "bg-bg-muted text-text" : "",
                    )}
                    disabled={gridAction.disabled}
                    aria-label={gridAction.label}
                    title={gridAction.label}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (gridAction.disabled) {
                        return;
                      }
                      onClose();
                      gridAction.onSelect();
                    }}
                  >
                    <span className="flex w-3.5 shrink-0 items-center justify-center">
                      {gridAction.icon ? (
                        <gridAction.icon size={MENU_ICON_SIZE} />
                      ) : gridAction.glyph ? (
                        <span className="text-[11px] font-medium leading-none" aria-hidden="true">
                          {gridAction.glyph}
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0 truncate">{gridAction.label}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        }

        if (action.type === "scroll-actions") {
          const maxVisibleItems = action.maxVisibleItems ?? 3;
          return (
            <div
              key={action.key ?? `scroll-actions-${index}`}
              role="group"
              aria-label={action.ariaLabel ?? "滚动操作"}
              className="context-menu__scroll-actions overflow-y-auto pr-0.5"
              style={{ maxHeight: maxVisibleItems * MENU_ITEM_HEIGHT }}
              onMouseEnter={() => setOpenSubmenuIndex(null)}
            >
              <div className="grid gap-0.5">
                {action.actions.map((scrollAction) => (
                  <button
                    key={scrollAction.key ?? scrollAction.label}
                    type="button"
                    role="menuitem"
                    className={cn(
                      "context-menu__item flex min-h-7 w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[11px] transition-colors outline-none",
                      scrollAction.disabled
                        ? "cursor-not-allowed text-text-soft"
                        : "text-text-muted hover:bg-bg-hover hover:text-text focus-visible:bg-bg-hover focus-visible:text-text",
                    )}
                    disabled={scrollAction.disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (scrollAction.disabled) {
                        return;
                      }
                      onClose();
                      scrollAction.onSelect();
                    }}
                  >
                    <span className="flex w-3.5 shrink-0 items-center justify-center">
                      {scrollAction.icon ? <scrollAction.icon size={MENU_ICON_SIZE} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{scrollAction.label}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        }

        return (
          <button
            key={action.key ?? action.label}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            type="button"
            role="menuitem"
            aria-haspopup={action.type === "submenu" ? "menu" : undefined}
            aria-expanded={action.type === "submenu" ? openSubmenuIndex === index : undefined}
            data-featured={action.featured ? "true" : undefined}
            data-selected={action.selected ? "true" : undefined}
            className={cn(
              "context-menu__item flex min-h-7 w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[11px] transition-colors outline-none",
              action.featured ? "bg-bg-muted text-text" : "bg-transparent",
              isActionButton(action) && action.disabled
                ? "cursor-not-allowed text-text-soft"
                : "text-text-muted hover:bg-bg-hover hover:text-text focus-visible:bg-bg-hover focus-visible:text-text",
              action.type === "submenu" && openSubmenuIndex === index
                ? "bg-bg-hover text-text"
                : "",
              isActionWithTone(action) && action.tone === "danger"
                ? "text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)]"
                : "",
            )}
            disabled={isActionButton(action) ? action.disabled : undefined}
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
            <span className="flex w-3.5 shrink-0 items-center justify-center">
              {action.icon ? <action.icon size={MENU_ICON_SIZE} /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
            <span className="flex shrink-0 items-center gap-2">
              {action.selected ? (
                <span className="text-text">
                  <Check size={MENU_ICON_SIZE} />
                </span>
              ) : null}
              {action.type === "submenu" ? (
                <span className="text-text-soft">
                  <ChevronRight size={MENU_ICON_SIZE} />
                </span>
              ) : action.shortcut ? (
                <span className="text-[10px] uppercase tracking-[0.06em] text-text-soft">
                  {action.shortcut}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
      {activeSubmenu ? (
        <div
          className="absolute z-[81]"
          style={{
            left:
              openSubmenuSide === "right"
                ? `calc(100% + ${SUBMENU_GAP}px)`
                : undefined,
            right:
              openSubmenuSide === "left"
                ? `calc(100% + ${SUBMENU_GAP}px)`
                : undefined,
            top: openSubmenuTop,
          }}
        >
          <PopoverPanel className="context-menu__submenu-panel w-[11rem] rounded-[8px] border p-1 backdrop-blur-[18px]">
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

function getActionHeight(action: ContextMenuAction) {
  if (action.type === "separator") {
    return MENU_SEPARATOR_HEIGHT;
  }

  if (action.type === "quick-actions") {
    return MENU_QUICK_ACTIONS_HEIGHT;
  }

  if (action.type === "inline-actions") {
    const columns = action.columns ?? DEFAULT_INLINE_COLUMNS;
    return Math.ceil(action.actions.length / Math.max(columns, 1)) * MENU_INLINE_ACTION_ROW_HEIGHT;
  }

  if (action.type === "grid-actions") {
    const columns = action.columns ?? DEFAULT_GRID_COLUMNS;
    const titleHeight = action.title ? MENU_SECTION_LABEL_HEIGHT : 0;
    return titleHeight + Math.ceil(action.actions.length / Math.max(columns, 1)) * MENU_GRID_ACTION_ROW_HEIGHT;
  }

  if (action.type === "scroll-actions") {
    return Math.min(action.actions.length, action.maxVisibleItems ?? 3) * MENU_ITEM_HEIGHT;
  }

  if (action.type === "section-label") {
    return MENU_SECTION_LABEL_HEIGHT;
  }

  return MENU_ITEM_HEIGHT;
}
