import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";

interface SurfaceCardProps extends HTMLAttributes<HTMLElement> {
  as?: "article" | "section" | "div" | "button";
  subtle?: boolean;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
}

export function SurfaceCard({
  as = "div",
  className,
  subtle = false,
  ...props
}: SurfaceCardProps) {
  const Component = as;
  return (
    <Component
      className={cn(
        "rounded-[var(--radius-8)] border border-border",
        subtle ? "bg-bg-subtle" : "bg-bg",
        className,
      )}
      {...props}
    />
  );
}
