import { StatusBadge } from "../../ui/components";
import { resolveTodoSource } from "./todo-utils";

export function TodoSourceLabel({
  activityId,
  activityNameById,
}: {
  activityId?: number | null;
  activityNameById: ReadonlyMap<number, string>;
}) {
  return <StatusBadge tone="neutral">{resolveTodoSource(activityId, activityNameById)}</StatusBadge>;
}
