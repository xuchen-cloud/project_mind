import type { FileTagColorKey } from "../../lib/types";
import {
  activityAttributeLabel,
  colorKeyBadgeStyle,
} from "../../lib/constants";
import { cn } from "../../ui/lib/cn";

interface ActivityAttributeTagProps {
  label?: string | null;
  colorKey?: FileTagColorKey | null;
  className?: string;
}

export function ActivityAttributeTag({
  label,
  colorKey = null,
  className,
}: ActivityAttributeTagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[var(--radius-4)] px-1.5 py-0.5 text-caption font-medium uppercase tracking-[0.14em]",
        colorKey ? "" : "bg-bg-muted text-text-muted",
        className,
      )}
      style={colorKey ? colorKeyBadgeStyle(colorKey) : undefined}
    >
      {activityAttributeLabel(label)}
    </span>
  );
}
