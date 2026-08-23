import { CircleAlert, CircleCheck, LoaderCircle, Minus } from "lucide-react";

import { useFeedbackStore } from "../../state/feedback-store";
import { StatusBadge } from "../../ui/components";

interface StatusBarProps {
  context?: string | null;
  detail?: string | null;
  onRetrySave?: () => void;
}

export function StatusBar({ context, detail, onRetrySave }: StatusBarProps) {
  const status = useFeedbackStore((state) => state.status);

  return (
    <footer className="flex h-8 items-center justify-between gap-3 border-t border-border px-3 text-ui text-text-muted">
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
        {onRetrySave ? (
          <button
            type="button"
            className="font-medium text-danger hover:underline"
            onClick={onRetrySave}
          >
            重试保存
          </button>
        ) : null}
        {context ? <span className="truncate">{context}</span> : null}
        {detail ? <span className="truncate">{detail}</span> : null}
      </div>
    </footer>
  );
}
