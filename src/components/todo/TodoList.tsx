import type { TodoRecord } from "../../lib/types";
import { EmptyState } from "../../ui/components";
import { TodoListItem } from "./TodoListItem";

export function TodoList({
  todos,
  activityNameById,
  compact = false,
  allowInlineEdit = false,
  allowInlineProgress = false,
  expandedTodoIds,
  onToggleExpanded,
  emptyText,
  onToggleStatus,
  onUpdateContent,
  onAddProgress,
  onError,
}: {
  todos: TodoRecord[];
  activityNameById: ReadonlyMap<number, string>;
  compact?: boolean;
  allowInlineEdit?: boolean;
  allowInlineProgress?: boolean;
  expandedTodoIds: ReadonlySet<number>;
  onToggleExpanded: (todoId: number) => void;
  emptyText: string;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onError?: (message: string) => void;
}) {
  return (
    <div className="grid gap-2">
      {todos.length > 0 ? (
        <div className="overflow-hidden rounded-[var(--radius-8)] border border-border bg-bg">
          {todos.map((todo, index) => (
            <TodoListItem
              key={todo.id}
              todo={todo}
              isFirst={index === 0}
              compact={compact}
              allowInlineEdit={allowInlineEdit}
              allowInlineProgress={allowInlineProgress}
              expanded={expandedTodoIds.has(todo.id)}
              activityNameById={activityNameById}
              onError={onError}
              onToggleExpanded={onToggleExpanded}
              onToggleStatus={onToggleStatus}
              onUpdateContent={onUpdateContent}
              onAddProgress={onAddProgress}
            />
          ))}
        </div>
      ) : (
        <EmptyState text={emptyText} compact />
      )}
    </div>
  );
}
