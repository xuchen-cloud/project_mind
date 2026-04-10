import type { ComponentProps } from "react";
import { Star } from "lucide-react";

import { cn } from "../lib/cn";
import { IconButton } from "./IconButton";

interface ProjectStarButtonProps
  extends Omit<ComponentProps<typeof IconButton>, "children" | "aria-label" | "title"> {
  active: boolean;
  activeLabel?: string;
  inactiveLabel?: string;
  iconSize?: number;
}

export function ProjectStarButton({
  active,
  activeLabel = "取消项目级标星",
  inactiveLabel = "项目级标星",
  className,
  iconSize = 12,
  size = "sm",
  type = "button",
  ...props
}: ProjectStarButtonProps) {
  const label = active ? activeLabel : inactiveLabel;

  return (
    <IconButton
      type={type}
      size={size}
      className={cn(
        active &&
          "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-accent hover:border-[color-mix(in_srgb,var(--color-accent)_28%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] hover:text-accent",
        className,
      )}
      title={label}
      aria-label={label}
      aria-pressed={active}
      {...props}
    >
      <Star size={iconSize} className={active ? "fill-current" : ""} />
    </IconButton>
  );
}
