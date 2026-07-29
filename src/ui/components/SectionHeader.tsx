import type { ReactNode } from "react";

import { cn } from "../lib/cn";

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="mt-1 text-title font-medium text-text">{title}</h2>
        {description ? (
          <p className="mt-1 text-body text-text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
