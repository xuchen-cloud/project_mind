import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export function PopoverPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-8)] border border-border bg-bg p-2 shadow-[var(--shadow-md)]",
        className,
      )}
      {...props}
    />
  );
}
