import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "../lib/cn";
import { useMotionPresence } from "../../hooks/useMotionPresence";
import { IconButton } from "./IconButton";

interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  widthClassName?: string;
  bodyClassName?: string;
  layerClassName?: string;
  positionClassName?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

interface ActiveDialog {
  host: HTMLDivElement;
  panel: HTMLDivElement;
  restoreFocusTo: HTMLElement | null;
}

const activeDialogs: ActiveDialog[] = [];
const priorInertState = new Map<HTMLElement, boolean>();

function syncBackgroundInert() {
  const topDialog = activeDialogs[activeDialogs.length - 1];

  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (!priorInertState.has(child)) priorInertState.set(child, child.hasAttribute("inert"));
    if (child === topDialog?.host) child.removeAttribute("inert");
    else child.setAttribute("inert", "");
  }
}

function restoreBackgroundInert() {
  for (const [element, wasInert] of priorInertState) {
    if (wasInert) element.setAttribute("inert", "");
    else element.removeAttribute("inert");
  }
  priorInertState.clear();
}

function focusableElements(panel: HTMLElement) {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  footer,
  children,
  widthClassName,
  bodyClassName,
  layerClassName = "z-40",
  positionClassName,
  initialFocusRef,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const presence = useMotionPresence(open);

  onCloseRef.current = onClose;
  if (hostRef.current === null && typeof document !== "undefined") {
    hostRef.current = document.createElement("div");
    hostRef.current.dataset.dialogPortal = "";
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!presence.mounted || !host) return undefined;

    document.body.append(host);
    return () => host.remove();
  }, [presence.mounted]);

  useEffect(() => {
    const host = hostRef.current;
    const panel = panelRef.current;
    if (!open || !host || !panel) return undefined;

    const dialog: ActiveDialog = {
      host,
      panel,
      restoreFocusTo:
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    activeDialogs.push(dialog);
    syncBackgroundInert();

    const focusTarget = initialFocusRef?.current ?? focusableElements(panel)[0] ?? panel;
    focusTarget.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeDialogs[activeDialogs.length - 1] !== dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const index = activeDialogs.indexOf(dialog);
      const wasTopDialog = index === activeDialogs.length - 1;
      if (index >= 0) activeDialogs.splice(index, 1);

      if (activeDialogs.length === 0) restoreBackgroundInert();
      else syncBackgroundInert();

      if (wasTopDialog && dialog.restoreFocusTo?.isConnected) {
        dialog.restoreFocusTo.focus();
      }
    };
  }, [initialFocusRef, open, presence.mounted]);

  if (!presence.mounted || !hostRef.current) {
    return null;
  }

  return createPortal(
    <div
      className={cn(
        "dialog-backdrop fixed inset-0 flex items-center justify-center bg-overlay px-4 py-6",
        layerClassName,
        positionClassName,
      )}
      data-state={presence.state}
      aria-hidden={!open || undefined}
      inert={!open ? true : undefined}
      onTransitionEnd={presence.onTransitionEnd}
      onMouseDown={(event) => {
        if (open && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={cn(
          "dialog-surface flex max-h-[min(88dvh,60rem)] w-full flex-col overflow-hidden rounded-[var(--radius-12)] border bg-bg shadow-[var(--shadow-md)]",
          "border-[color-mix(in_srgb,var(--color-border-strong)_58%,white)]",
          widthClassName ?? "max-w-xl",
        )}
        data-state={presence.state}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-title font-medium text-text">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-body text-text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton
            aria-label="关闭对话框"
            size="sm"
            onClick={onClose}
          >
            <X size={14} />
          </IconButton>
        </div>

        <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", bodyClassName)}>
          {children}
        </div>

        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    hostRef.current,
  );
}
