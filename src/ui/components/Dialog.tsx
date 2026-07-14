import { type ReactNode, useEffect, useId } from "react";
import { X } from "lucide-react";

import { cn } from "../lib/cn";
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
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center bg-overlay px-4 py-6 backdrop-blur-[3px]",
        layerClassName,
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={cn(
          "flex max-h-[min(88dvh,60rem)] w-full flex-col overflow-hidden rounded-[var(--radius-12)] border bg-bg shadow-[var(--shadow-md)]",
          "border-[color-mix(in_srgb,var(--color-border-strong)_58%,white)]",
          widthClassName ?? "max-w-xl",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none h-px bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--color-border-strong)_36%,white),transparent)]"
        />
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
    </div>
  );
}
