import { useEffect, useMemo, useState } from "react";

import type { InternalReferenceTarget } from "../../lib/internalReferences";
import type { TodoPriority, TodoRecord } from "../../lib/types";
import { DeleteContextMenu, EmptyState } from "../../ui/components";
import { TodoListItem } from "./TodoListItem";

export function TodoList({
  todos,
  activityNameById,
  activityOptions,
  compact = false,
  allowInlineEdit = false,
  allowInlineProgress = false,
  expandedTodoIds,
  onToggleExpanded,
  emptyText,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onUpdateActivity,
  onAddProgress,
  onUpdateProgress,
  onDeleteProgress,
  onDeleteTodo,
  onOpenTodoSource,
  onError,
  onEmptyClick,
  onOpenInternalReference,
}: {
  todos: TodoRecord[];
  activityNameById: ReadonlyMap<number, string>;
  activityOptions: Array<{ id: number; title: string }>;
  compact?: boolean;
  allowInlineEdit?: boolean;
  allowInlineProgress?: boolean;
  expandedTodoIds: ReadonlySet<number>;
  onToggleExpanded: (todoId: number, nextExpanded?: boolean) => void;
  emptyText: string;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onUpdateActivity: (todoId: number, activityId: number | null) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onUpdateProgress: (
    progressId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onDeleteProgress: (progressId: number) => Promise<unknown> | void;
  onDeleteTodo: (todoId: number) => Promise<unknown> | void;
  onOpenTodoSource: (todo: TodoRecord) => void;
  onError?: (message: string) => void;
  onEmptyClick?: () => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
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
              activityOptions={activityOptions}
              expanded={expandedTodoIds.has(todo.id)}
              activityNameById={activityNameById}
              onError={onError}
              onToggleExpanded={onToggleExpanded}
              onToggleStatus={onToggleStatus}
              onUpdatePriority={onUpdatePriority}
              onUpdateContent={onUpdateContent}
              onUpdateActivity={onUpdateActivity}
              onAddProgress={onAddProgress}
              onUpdateProgress={onUpdateProgress}
              onDeleteProgress={onDeleteProgress}
              onOpenContextMenu={(todoId, x, y) => setContextMenu({ todoId, x, y })}
              onOpenTodoSource={onOpenTodoSource}
              onOpenInternalReference={onOpenInternalReference}
            />
          ))}
        </div>
      ) : (
        onEmptyClick ? (
          <button type="button" className="w-full text-left" onClick={onEmptyClick}>
            <EmptyState text={emptyText} compact />
          </button>
        ) : (
          <EmptyState text={emptyText} compact />
        )
      )}
      {contextMenu && contextMenuTodo ? (
        <DeleteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="待办操作"
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            void Promise.resolve(onDeleteTodo(contextMenuTodo.id));
          }}
        />
      ) : null}
    </div>
  );
}
