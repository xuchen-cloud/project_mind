import { cn } from "../../ui/lib/cn";
import type { TodoSortMode } from "./todo-utils";

export function TodoSortSwitch({
  value,
  onChange,
}: {
  value: TodoSortMode;
  onChange: (value: TodoSortMode) => void;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-full bg-bg-muted p-0.5"
      role="tablist"
      aria-label="Todo 排序方式"
    >
      <button
        type="button"
        className={cn(
          "h-7 rounded-full px-2 text-ui font-medium transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
          value === "time"
            ? "bg-bg text-text"
            : "text-text-soft hover:text-text",
        )}
        onClick={() => onChange("time")}
      >
        按时间
      </button>
      <button
        type="button"
        className={cn(
          "h-7 rounded-full px-2 text-ui font-medium transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
          value === "priority"
            ? "bg-bg text-text"
            : "text-text-soft hover:text-text",
        )}
        onClick={() => onChange("priority")}
      >
        按优先级
      </button>
    </div>
  );
}
