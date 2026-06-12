import { useEffect, useMemo, useRef, useState } from "react";
import { Flag } from "lucide-react";

import type { InternalReferenceTarget } from "../../lib/internalReferences";
import type { ContactMentionTarget } from "../../lib/contactMentions";
import type { FileTagRecord, TodoPriority, TodoRecord } from "../../lib/types";
import { ActionContextMenu, EmptyState } from "../../ui/components";
import { TodoListItem } from "./TodoListItem";
import { TODO_PRIORITY_OPTIONS } from "./todo-utils";

const TODO_STATUS_TRANSITION_MS = 520;

type TodoStatusTransition = {
  todo: TodoRecord;
  phase: "completing" | "restoring";
};

export function TodoList({
  todos,
  compact = false,
  allowInlineEdit = false,
  allowInlineProgress = false,
  expandedTodoIds,
  onToggleExpanded,
  emptyText,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onUpdateTags,
  onAddProgress,
  onUpdateProgress,
  onDeleteProgress,
  onDeleteTodo,
  onError,
  onEmptyClick,
  onOpenInternalReference,
  onOpenContactMention,
  availableTags = [],
}: {
  todos: TodoRecord[];
  compact?: boolean;
  allowInlineEdit?: boolean;
  allowInlineProgress?: boolean;
  expandedTodoIds: ReadonlySet<number>;
  onToggleExpanded: (todoId: number, nextExpanded?: boolean) => void;
  emptyText: string;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onUpdateTags?: (todoId: number, tagIds: number[]) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onUpdateProgress: (
    progressId: number,
    payload: { content: string; progressDate: string; status?: TodoRecord["status"] },
  ) => Promise<unknown> | void;
  onDeleteProgress: (progressId: number) => Promise<unknown> | void;
  onDeleteTodo: (todoId: number) => Promise<unknown> | void;
  onError?: (message: string) => void;
  onEmptyClick?: () => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
  availableTags?: FileTagRecord[];
}) {
  const [contextMenu, setContextMenu] = useState<{
    todoId: number;
    x: number;
    y: number;
  } | null>(null);
  const [todoTransitions, setTodoTransitions] = useState<Record<number, TodoStatusTransition>>({});
  const transitionTimersRef = useRef(new Map<number, number>());
  const contextMenuTodo = useMemo(
    () => (contextMenu ? todos.find((todo) => todo.id === contextMenu.todoId) ?? null : null),
    [contextMenu, todos],
  );
  const visibleTodos = useMemo(() => {
    const existingIds = new Set(todos.map((todo) => todo.id));
    const replacedTodos = todos.map((todo) => todoTransitions[todo.id]?.todo ?? todo);
    const missingTransitionTodos = Object.entries(todoTransitions)
      .filter(([todoId]) => !existingIds.has(Number(todoId)))
      .map(([, transition]) => transition.todo);

    return [...replacedTodos, ...missingTransitionTodos];
  }, [todoTransitions, todos]);

  useEffect(() => {
    if (contextMenu && !contextMenuTodo) {
      setContextMenu(null);
    }
  }, [contextMenu, contextMenuTodo]);

  useEffect(() => {
    return () => {
      transitionTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      transitionTimersRef.current.clear();
    };
  }, []);

  function clearTodoTransition(todoId: number) {
    const timerId = transitionTimersRef.current.get(todoId);
    if (timerId) {
      window.clearTimeout(timerId);
      transitionTimersRef.current.delete(todoId);
    }
    setTodoTransitions((current) => {
      if (!current[todoId]) {
        return current;
      }

      const next = { ...current };
      delete next[todoId];
      return next;
    });
  }

  async function handleToggleStatus(todo: TodoRecord) {
    const nextStatus = todo.status === "finished" ? "unfinished" : "finished";
    const phase = nextStatus === "finished" ? "completing" : "restoring";

    setTodoTransitions((current) => ({
      ...current,
      [todo.id]: {
        todo: { ...todo, status: nextStatus },
        phase,
      },
    }));

    const existingTimerId = transitionTimersRef.current.get(todo.id);
    if (existingTimerId) {
      window.clearTimeout(existingTimerId);
    }
    transitionTimersRef.current.set(
      todo.id,
      window.setTimeout(() => clearTodoTransition(todo.id), TODO_STATUS_TRANSITION_MS),
    );

    try {
      await onToggleStatus(todo.id, nextStatus);
    } catch (error) {
      clearTodoTransition(todo.id);
      throw error;
    }
  }

  async function handleUpdatePriority(todoId: number, priority: TodoPriority) {
    await onUpdatePriority(todoId, priority);
    setContextMenu(null);
  }

  return (
    <div className="todo-list">
      {visibleTodos.length > 0 ? (
        <div className="todo-list__collection">
          {visibleTodos.map((todo, index) => (
            <TodoListItem
              key={todo.id}
              todo={todo}
              isFirst={index === 0}
              compact={compact}
              allowInlineEdit={allowInlineEdit}
              allowInlineProgress={allowInlineProgress}
              expanded={expandedTodoIds.has(todo.id)}
              statusTransition={todoTransitions[todo.id]?.phase}
              onError={onError}
              onToggleExpanded={onToggleExpanded}
              onToggleStatus={() => handleToggleStatus(todo)}
              onUpdatePriority={handleUpdatePriority}
              onUpdateContent={onUpdateContent}
              onUpdateTags={onUpdateTags}
              onAddProgress={onAddProgress}
              onUpdateProgress={onUpdateProgress}
              onDeleteProgress={onDeleteProgress}
              onOpenContextMenu={(todoId, x, y) => setContextMenu({ todoId, x, y })}
              onOpenInternalReference={onOpenInternalReference}
              onOpenContactMention={onOpenContactMention}
              availableTags={availableTags}
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
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="待办操作"
          onClose={() => setContextMenu(null)}
          actions={[
            {
              type: "submenu",
              key: "priority",
              label: "优先级",
              icon: Flag,
              actions: TODO_PRIORITY_OPTIONS.map((option) => ({
                key: option.value,
                label: option.label,
                selected: contextMenuTodo.priority === option.value,
                onSelect: () => {
                  void handleUpdatePriority(contextMenuTodo.id, option.value);
                },
              })),
            },
            { type: "separator", key: "separator-delete" },
            {
              key: "delete",
              label: "删除",
              tone: "danger",
              onSelect: () => {
                setContextMenu(null);
                void Promise.resolve(onDeleteTodo(contextMenuTodo.id));
              },
            },
          ]}
        />
      ) : null}
    </div>
  );
}
