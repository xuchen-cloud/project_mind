import { CircleAlert, CircleCheck, LoaderCircle, Minus } from "lucide-react";

import { useFeedbackStore } from "../../state/feedback-store";
import { StatusBadge } from "../../ui/components";

interface StatusBarProps {
  context?: string | null;
  detail?: string | null;
}

export function StatusBar({ context, detail }: StatusBarProps) {
  const status = useFeedbackStore((state) => state.status);

  return (
    <footer className="flex h-10 items-center justify-between gap-4 border-t border-border px-4 text-ui text-text-muted">
      <div className="flex min-w-0 items-center gap-3">
        <StatusBadge
          tone={
            status.tone === "neutral"
              ? "neutral"
              : status.tone === "success"
                ? "success"
                : status.tone === "warning"
                  ? "warning"
                  : "danger"
          }
        >
          {status.label}
        </StatusBadge>
        <div className="inline-flex min-w-0 items-center gap-2 truncate">
          {status.tone === "success" ? (
            <CircleCheck size={14} className="shrink-0 text-success" />
          ) : status.tone === "warning" ? (
            <LoaderCircle size={14} className="shrink-0 text-warning" />
          ) : status.tone === "error" ? (
            <CircleAlert size={14} className="shrink-0 text-danger" />
          ) : (
            <Minus size={14} className="shrink-0 text-text-soft" />
          )}
          <p className="truncate">{status.message}</p>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-3 text-text-soft">
        {context ? <span className="truncate">{context}</span> : null}
        {detail ? <span className="truncate">{detail}</span> : null}
      </div>
    </footer>
  );
}
