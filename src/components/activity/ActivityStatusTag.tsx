import type { FileTagColorKey } from "../../lib/types";
import { activityStatusLabel, colorKeyBadgeStyle } from "../../lib/constants";
import { cn } from "../../ui/lib/cn";

interface ActivityStatusTagProps {
  label?: string | null;
  colorKey?: FileTagColorKey | null;
  className?: string;
}

export function ActivityStatusTag({
  label,
  colorKey = null,
  className,
}: ActivityStatusTagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[var(--radius-4)] px-1.5 py-0.5 text-caption font-medium tracking-[0.08em]",
        colorKey ? "" : "bg-bg-muted text-text-muted",
        className,
      )}
      style={colorKey ? colorKeyBadgeStyle(colorKey) : undefined}
    >
      {activityStatusLabel(label)}
    </span>
  );
}
