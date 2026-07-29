import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "subtle" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export function Button({
  className,
  variant = "secondary",
  size = "md",
  block = false,
  leadingIcon,
  trailingIcon,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[var(--radius-6)] border text-ui font-medium transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-[160ms] ease-[var(--ease-soft)] disabled:pointer-events-none disabled:opacity-60",
        size === "sm" ? "h-7 px-2.5" : "h-8 px-3",
        block && "w-full",
        variant === "primary" &&
          "border-text bg-text text-bg hover:border-text hover:opacity-95",
        variant === "secondary" &&
          "border-border bg-bg text-text hover:border-border-strong hover:bg-bg-subtle",
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
      {leadingIcon ? <span className="shrink-0">{leadingIcon}</span> : null}
      {children}
      {trailingIcon ? <span className="shrink-0">{trailingIcon}</span> : null}
    </button>
  );
}
