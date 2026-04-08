import { todoPriorityMeta, todoPriorityOptionLabel } from "../../lib/todo-priority";
import type { TodoPriority } from "../../lib/types";
import { StatusBadge } from "../../ui/components";

export function TodoPriorityBadge({ priority }: { priority: TodoPriority }) {
  const meta = todoPriorityMeta(priority);
  const label = todoPriorityOptionLabel(priority);

  return (
    <StatusBadge tone={meta.tone} title={label} aria-label={label}>
      {meta.code}
    </StatusBadge>
  );
}
