import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

import type { ToastItem } from "../../state/feedback-store";
import { IconButton } from "../../ui/components";
import { cancelListLayoutMotion, commitListLayoutChange } from "../../ui/listLayoutMotion";
import { MOTION_DURATION_MS } from "../../ui/motion";

type RenderedToast = ToastItem & { presence: "present" | "closing" };

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const [renderedToasts, setRenderedToasts] = useState<RenderedToast[]>(() =>
    toasts.map((toast) => ({ ...toast, presence: "present" })),
  );
  const stackRef = useRef<HTMLDivElement | null>(null);
  const motionContainerRef = useRef<HTMLDivElement | null>(null);
  const exitTimersRef = useRef(new Map<number, number>());

  function finishToastExit(id: number) {
    const timer = exitTimersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    exitTimersRef.current.delete(id);
    commitListLayoutChange(stackRef.current, () => {
      setRenderedToasts((current) => current.filter((toast) => toast.id !== id));
    });
  }

  useEffect(() => {
    commitListLayoutChange(stackRef.current, () => {
      setRenderedToasts((current) => {
        const incoming = new Map(toasts.map((toast) => [toast.id, toast]));
        const next = current.map((toast) => {
          const replacement = incoming.get(toast.id);
          if (!replacement) return { ...toast, presence: "closing" as const };
          incoming.delete(toast.id);
          return { ...replacement, presence: "present" as const };
        });
        return [
          ...next,
          ...Array.from(incoming.values(), (toast) => ({ ...toast, presence: "present" as const })),
        ];
      });
    });
  }, [toasts]);

  useEffect(() => {
    const closingIds = new Set(
      renderedToasts.filter((toast) => toast.presence === "closing").map((toast) => toast.id),
    );
    for (const [id, timer] of exitTimersRef.current) {
      if (!closingIds.has(id)) {
        window.clearTimeout(timer);
        exitTimersRef.current.delete(id);
      }
    }
    for (const id of closingIds) {
      if (exitTimersRef.current.has(id)) continue;
      const timer = window.setTimeout(() => finishToastExit(id), MOTION_DURATION_MS.standard);
      exitTimersRef.current.set(id, timer);
    }
  }, [renderedToasts]);

  useEffect(() => {
    return () => {
      exitTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      exitTimersRef.current.clear();
      cancelListLayoutMotion(motionContainerRef.current);
    };
  }, []);

  if (renderedToasts.length === 0) return null;

  return (
    <div
      ref={(element) => {
        stackRef.current = element;
        if (element) motionContainerRef.current = element;
      }}
      className="fixed top-14 right-4 z-50 flex flex-col gap-2"
      data-list-layout-motion
    >
      {renderedToasts.map((toast) => (
        <div
          key={toast.id}
          data-layout-motion-id={`toast-${toast.id}`}
          data-state={toast.presence}
          aria-hidden={toast.presence === "closing" || undefined}
          inert={toast.presence === "closing" ? true : undefined}
          onTransitionEnd={(event) => {
            if (toast.presence === "closing" && event.target === event.currentTarget) {
              finishToastExit(toast.id);
            }
          }}
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
