import { forwardRef, type CSSProperties, type HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export interface PopoverPanelProps extends HTMLAttributes<HTMLDivElement> {
  motion?: "trigger";
  motionOrigin?: CSSProperties["transformOrigin"];
}

export const PopoverPanel = forwardRef<HTMLDivElement, PopoverPanelProps>(
  ({ className, motion, motionOrigin, style, ...props }, ref) => (
    <div
      ref={ref}
      data-motion={motion}
      className={cn(
        "rounded-[var(--radius-8)] border border-border bg-bg p-2 shadow-[var(--shadow-md)]",
        className,
      )}
      style={{ ...style, transformOrigin: motionOrigin ?? style?.transformOrigin }}
      {...props}
    />
  ),
);

PopoverPanel.displayName = "PopoverPanel";
