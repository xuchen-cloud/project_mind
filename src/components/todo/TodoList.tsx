import { useEffect, useMemo, useState } from "react";

import type { TodoPriority, TodoRecord } from "../../lib/types";
import { DeleteContextMenu, EmptyState } from "../../ui/components";
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
  onUpdatePriority,
  onUpdateContent,
  onAddProgress,
  onDeleteTodo,
  onOpenTodoSource,
  onError,
}: {
  todos: TodoRecord[];
  activityNameById: ReadonlyMap<number, string>;
  compact?: boolean;
  allowInlineEdit?: boolean;
  allowInlineProgress?: boolean;
  expandedTodoIds: ReadonlySet<number>;
  onToggleExpanded: (todoId: number, nextExpanded?: boolean) => void;
  emptyText: string;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onDeleteTodo: (todoId: number) => Promise<unknown> | void;
  onOpenTodoSource: (todo: TodoRecord) => void;
  onError?: (message: string) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{
    todoId: number;
    x: number;
    y: number;
  } | null>(null);
  const contextMenuTodo = useMemo(
    () => (contextMenu ? todos.find((todo) => todo.id === contextMenu.todoId) ?? null : null),
    [contextMenu, todos],
  );

  useEffect(() => {
    if (contextMenu && !contextMenuTodo) {
      setContextMenu(null);
    }
  }, [contextMenu, contextMenuTodo]);

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
              onUpdatePriority={onUpdatePriority}
              onUpdateContent={onUpdateContent}
              onAddProgress={onAddProgress}
              onOpenContextMenu={(todoId, x, y) => setContextMenu({ todoId, x, y })}
              onOpenTodoSource={onOpenTodoSource}
            />
          ))}
        </div>
      ) : (
        <EmptyState text={emptyText} compact />
      )}
      {contextMenu && contextMenuTodo ? (
        <DeleteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="待办操作"
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            if (!window.confirm("确定删除这条代办吗？删除后无法恢复。")) {
              return;
            }
            void Promise.resolve(onDeleteTodo(contextMenuTodo.id));
          }}
        />
      ) : null}
    </div>
  );
}
