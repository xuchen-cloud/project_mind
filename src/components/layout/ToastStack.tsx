import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

import type { ToastItem } from "../../state/feedback-store";
import { IconButton } from "../../ui/components";

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={[
            "toast-item flex min-w-[280px] max-w-[380px] items-start justify-between gap-3 rounded-[var(--radius-8)] border px-3 py-3 text-body shadow-[var(--shadow-md)]",
            toast.tone === "success"
              ? "border-[color-mix(in_srgb,var(--color-success)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-success)_10%,var(--color-bg))] text-success"
              : toast.tone === "error"
                ? "border-[color-mix(in_srgb,var(--color-danger)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--color-bg))] text-danger"
                : "border-border bg-bg text-text",
          ].join(" ")}
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 shrink-0">
              {toast.tone === "success" ? (
                <CircleCheck size={16} />
              ) : toast.tone === "error" ? (
                <CircleAlert size={16} />
              ) : (
                <Info size={16} />
              )}
            </span>
            <div
              className="min-w-0"
              role={toast.tone === "error" ? "alert" : "status"}
              aria-live={toast.tone === "error" ? "assertive" : "polite"}
              aria-atomic="true"
            >
              <p className="font-medium leading-snug">{toast.title}</p>
              {toast.detail ? (
                <p className="mt-0.5 text-ui opacity-80">{toast.detail}</p>
              ) : null}
            </div>
          </div>
          <IconButton
            type="button"
            size="sm"
            className="mt-[-2px]"
            aria-label={`关闭通知：${toast.title}`}
            onClick={() => onDismiss(toast.id)}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
