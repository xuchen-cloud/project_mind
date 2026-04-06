import type { TodoPriority } from "../../lib/types";
import { StatusBadge } from "../../ui/components";
import { priorityLabel } from "./todo-utils";

export function TodoPriorityBadge({ priority }: { priority: TodoPriority }) {
  const label = priorityLabel(priority);

  const tone =
    priority === "urgent_important"
      ? "danger"
      : priority === "urgent_not_important"
        ? "warning"
        : priority === "not_urgent_important"
          ? "accent"
          : "neutral";

  return (
    <StatusBadge tone={tone} title={label} aria-label={label}>
      {label}
    </StatusBadge>
  );
}
