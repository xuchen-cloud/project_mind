import { Pin } from "lucide-react";
import { cn } from "../lib/cn";

/** Shared trailing status mark for pinned and starred list items. */
export function ListPinIndicator({ label = "已置顶", className }: {
  label?: string;
  className?: string;
}) {
  return <Pin size={12} aria-label={label}
    className={cn("list-pin-indicator ml-auto self-center shrink-0 text-text-tertiary", className)} />;
}
