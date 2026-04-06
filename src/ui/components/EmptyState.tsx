import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

import { cn } from "../lib/cn";

interface EmptyStateProps {
  title?: string;
  text: string;
  compact?: boolean;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  text,
  compact = false,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[var(--radius-8)] border border-dashed border-border bg-bg-subtle text-center",
        compact ? "gap-2 px-4 py-5" : "gap-3 px-5 py-10",
        className,
      )}
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-8)] bg-bg text-text-soft">
        {icon ?? <Inbox size={16} />}
      </div>
      {title ? <p className="text-body font-medium text-text">{title}</p> : null}
      <p className="max-w-[32rem] text-body text-text-muted">{text}</p>
      {action}
    </div>
  );
}
