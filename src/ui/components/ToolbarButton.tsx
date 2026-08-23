import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";
import { pressableFeedbackClassName } from "./pressableStyles";

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  busy?: boolean;
  children: ReactNode;
}

export function ToolbarButton({
  className,
  active = false,
  children,
  ...props
}: ToolbarButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-6)] border border-transparent bg-transparent text-text-muted hover:bg-bg-hover hover:text-text disabled:pointer-events-none disabled:opacity-50",
        pressableFeedbackClassName,
        active &&
          "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-accent",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
