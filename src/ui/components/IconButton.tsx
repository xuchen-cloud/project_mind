import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { pressableFeedbackClassName } from "./pressableStyles";

type IconButtonVariant = "secondary" | "ghost" | "subtle" | "danger";
type IconButtonSize = "sm" | "md";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant = "ghost", size = "md", children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[var(--radius-6)] border disabled:pointer-events-none disabled:opacity-60",
        pressableFeedbackClassName,
        size === "sm" ? "h-7 w-7" : "h-8 w-8",
        variant === "secondary" &&
          "border-border bg-bg text-text-muted hover:border-border-strong hover:bg-bg-subtle hover:text-text",
        variant === "ghost" &&
          "border-transparent bg-transparent text-text-muted hover:bg-bg-hover hover:text-text",
        variant === "subtle" &&
          "border-transparent bg-bg-muted text-text-muted hover:bg-bg-hover hover:text-text",
        variant === "danger" &&
          "border-transparent bg-transparent text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)]",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
