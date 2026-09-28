import type { TodoPriority } from "../../lib/types";
import { TODO_PRIORITY_OPTIONS } from "./todo-utils";

/** Shared four-segment control for creating and editing a todo. */
export function TodoPrioritySelector({ value, onChange, disabled = false }: {
  value: TodoPriority;
  onChange: (priority: TodoPriority) => void;
  disabled?: boolean;
}) {
  return (
    <div className="todo-rail__priority-options" aria-label="Todo 优先级">
      {TODO_PRIORITY_OPTIONS.map((option) => (
        <button key={option.value} type="button" className="todo-rail__priority-button"
          aria-label={option.optionLabel} title={option.optionLabel}
          aria-pressed={value === option.value} disabled={disabled}
          onClick={() => onChange(option.value)}>
          <span className="todo-rail__priority-dot"
            style={{ color: option.colorValue }} />
        </button>
      ))}
    </div>
  );
}
