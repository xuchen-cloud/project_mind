import { useRef, type KeyboardEvent } from "react";

import { cn } from "../../ui/lib/cn";
import { getRovingTabTargetIndex } from "../../ui/rovingTabs";
import type { TodoSortMode } from "./todo-utils";

const SORT_MODES: TodoSortMode[] = ["time", "priority"];

export function TodoSortSwitch({
  value,
  onChange,
}: {
  value: TodoSortMode;
  onChange: (value: TodoSortMode) => void;
}) {
  const tabRefs = useRef<Record<TodoSortMode, HTMLButtonElement | null>>({
    time: null,
    priority: null,
  });

  function selectWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = SORT_MODES.indexOf(value);
    const nextIndex = getRovingTabTargetIndex({
      key: event.key,
      currentIndex,
      itemCount: SORT_MODES.length,
      vertical: true,
    });

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    const nextValue = SORT_MODES[nextIndex];
    tabRefs.current[nextValue]?.focus();
    onChange(nextValue);
  }

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-full bg-bg-muted p-0.5"
      role="tablist"
      aria-label="Todo 排序方式"
    >
      <button
        ref={(node) => {
          tabRefs.current.time = node;
        }}
        type="button"
        role="tab"
        aria-selected={value === "time"}
        tabIndex={value === "time" ? 0 : -1}
        className={cn(
          "h-7 rounded-full px-2 text-ui font-medium transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
          value === "time"
            ? "bg-bg text-text"
            : "text-text-soft hover:text-text",
        )}
        onClick={() => onChange("time")}
        onKeyDown={selectWithKeyboard}
      >
        按时间
      </button>
      <button
        ref={(node) => {
          tabRefs.current.priority = node;
        }}
        type="button"
        role="tab"
        aria-selected={value === "priority"}
        tabIndex={value === "priority" ? 0 : -1}
        className={cn(
          "h-7 rounded-full px-2 text-ui font-medium transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
          value === "priority"
            ? "bg-bg text-text"
            : "text-text-soft hover:text-text",
        )}
        onClick={() => onChange("priority")}
        onKeyDown={selectWithKeyboard}
      >
        按优先级
      </button>
    </div>
  );
}
