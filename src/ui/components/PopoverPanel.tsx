import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export const PopoverPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-8)] border border-border bg-bg p-2 shadow-[var(--shadow-md)]",
        className,
      )}
      {...props}
    />
  ),
);

PopoverPanel.displayName = "PopoverPanel";
