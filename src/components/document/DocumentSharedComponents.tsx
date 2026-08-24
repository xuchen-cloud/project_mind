import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";

import { formatDateTime } from "../../lib/formatters";
import type { DocumentRecord, DocumentTagRecord, DocumentVersionRecord, TagColorKey } from "../../lib/types";
import { tagColorValue } from "../../lib/constants";
import { projectMindApi } from "../../services/projectMindApi";
import { PopoverPanel, StatusBadge } from "../../ui/components";
import { cn } from "../../ui/lib/cn";

// Helper functions
export function canRenameDocument(document: DocumentRecord) {
  return document.health !== "missing";
}

export function stopPropagation(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) {
  event.stopPropagation();
}

export function handleRenameKeyDown(
  document: DocumentRecord,
  event: KeyboardEvent<HTMLInputElement>,
  cancelRename: () => void,
  commitRename: (document: DocumentRecord) => void,
) {
  if (event.key === "Enter") {
    event.preventDefault();
    commitRename(document);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancelRename();
  }
}

export function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest("button, input, select, textarea, a, [data-document-interactive='true']"))
    : false;
}

// DocumentContextMenuAction component
export function DocumentContextMenuAction({
  icon,
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  icon: ReactElement;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-[var(--radius-6)] px-2.5 py-2 text-left text-ui transition-colors",
        disabled
          ? "cursor-not-allowed text-text-soft"
          : danger
            ? "text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)]"
            : "text-text-muted hover:bg-bg-hover hover:text-text",
      )}
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{label}</span>
    </button>
  );
}

// DocumentTagDots component
export function DocumentTagDots({ tags }: { tags: DocumentTagRecord[] }) {
  if (tags.length === 0) {
    return null;
  }

  const visibleTags = tags.slice(0, 6);
  const hiddenCount = tags.length - visibleTags.length;

  return (
    <div
      className="inline-flex items-center gap-1"
      title={tags.map((tag) => tag.label).join(" / ")}
      aria-label={`项目标签：${tags.map((tag) => tag.label).join("、")}`}
    >
      {visibleTags.map((tag) => (
        <span
          key={tag.id}
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: tagColorValue(tag.colorKey) }}
          aria-hidden="true"
        />
      ))}
      {hiddenCount > 0 ? <span className="text-[10px] leading-3.5 text-text-soft">+{hiddenCount}</span> : null}
    </div>
  );
}

interface FloatingMenuPosition {
  left: number;
  top: number;
  width: number;
  placement: "top" | "bottom";
}

// DocumentVersionDropdown component
export function DocumentVersionDropdown({
  document,
  onOpenVersion,
}: {
  document: DocumentRecord;
  onOpenVersion: (version: DocumentVersionRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<FloatingMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const versionsQuery = useQuery({
    queryKey: ["documentVersions", document.id],
    queryFn: () =>
      projectMindApi.documentListVersions({
        documentId: document.id,
      }),
    enabled: open,
  });

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

    const handleEscape = (event: globalThis.KeyboardEvent) => {
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
      const menuWidth = Math.max(menuRef.current?.offsetWidth ?? 0, 220);
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const shouldOpenUp =
        menuHeight > 0 &&
        spaceBelow < menuHeight + gap + viewportPadding &&
        triggerRect.top > spaceBelow;

      const top = shouldOpenUp
        ? Math.max(viewportPadding, triggerRect.top - menuHeight - gap)
        : Math.max(
            viewportPadding,
            Math.min(triggerRect.bottom + gap, window.innerHeight - menuHeight - viewportPadding),
          );
      const left = Math.max(
        viewportPadding,
        Math.min(triggerRect.left, window.innerWidth - menuWidth - viewportPadding),
      );

      setMenuPosition({
        left,
        top,
        width: Math.max(triggerRect.width + 88, 220),
        placement: shouldOpenUp ? "top" : "bottom",
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, versionsQuery.data, versionsQuery.isLoading]);

  const versions = versionsQuery.data ?? [];

  return (
    <div ref={rootRef} className="relative shrink-0" data-document-interactive="true">
      <button
        ref={triggerRef}
        type="button"
        data-document-interactive="true"
        className="inline-flex items-center gap-1 rounded-[var(--radius-4)]"
        title="选择版本"
        aria-label={`选择 ${document.baseName} 的版本`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(event) => {
          stopPropagation(event);
          setOpen((current) => !current);
        }}
      >
        <StatusBadge tone="neutral" className="px-1 py-0 text-[10px] tracking-[0.1em]">
          v{document.currentVersionNumber}
        </StatusBadge>
        <ChevronDown
          size={12}
          className={cn(
            "shrink-0 text-text-soft transition-transform duration-[var(--duration-standard)] ease-[var(--ease-soft)] motion-reduce:transform-none motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="z-[120]"
              style={{
                position: "fixed",
                left: menuPosition?.left ?? 0,
                top: menuPosition?.top ?? 0,
                width: menuPosition?.width ?? 220,
                visibility: menuPosition ? "visible" : "hidden",
              }}
              data-document-interactive="true"
              onClick={stopPropagation}
            >
              <PopoverPanel
                className="min-w-[13.75rem] p-1.5"
                motion="trigger"
                motionOrigin={menuPosition?.placement === "top" ? "bottom left" : "top left"}
              >
                {versionsQuery.isLoading ? (
                  <p className="px-2.5 py-2 text-ui text-text-soft">正在加载版本...</p>
                ) : versions.length === 0 ? (
                  <p className="px-2.5 py-2 text-ui text-text-soft">没有可选版本</p>
                ) : (
                  <div className="grid gap-1" role="menu" aria-label={`${document.baseName} 版本列表`}>
                    {versions.map((version) => {
                      const isCurrent = version.versionNumber === document.currentVersionNumber;

                      return (
                        <button
                          key={version.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isCurrent}
                          className={cn(
                            "flex w-full items-start justify-between gap-3 rounded-[var(--radius-6)] px-2.5 py-2 text-left transition-colors",
                            isCurrent
                              ? "bg-bg-hover text-text"
                              : "text-text-muted hover:bg-bg-hover hover:text-text",
                          )}
                          onClick={() => {
                            onOpenVersion(version);
                            setOpen(false);
                          }}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="text-ui font-medium text-text">v{version.versionNumber}</span>
                              {isCurrent ? (
                                <span className="text-[10px] leading-4 text-text-soft">当前</span>
                              ) : null}
                            </span>
                            <span className="block truncate text-[11px] leading-4 text-text-soft">
                              {formatDateTime(version.createdAt)}
                            </span>
                          </span>
                          {isCurrent ? <Check size={14} className="mt-0.5 shrink-0 text-text-soft" /> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </PopoverPanel>
            </div>,
            globalThis.document.body,
          )
        : null}
    </div>
  );
}
