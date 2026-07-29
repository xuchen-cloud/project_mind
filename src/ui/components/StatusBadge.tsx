import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";

interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
}

export function StatusBadge({
  className,
  tone = "neutral",
  children,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[var(--radius-4)] px-1.5 py-0.5 text-caption font-medium uppercase tracking-[0.14em]",
        tone === "neutral" && "bg-bg-muted text-text-muted",
        tone === "accent" &&
          "bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-accent",
        tone === "success" &&
          "bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-success",
        tone === "warning" &&
          "bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-warning",
        tone === "danger" &&
          "bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-danger",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
