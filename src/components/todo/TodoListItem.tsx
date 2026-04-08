import { useState } from "react";
import { ChevronDown, ChevronUp, Check, Circle } from "lucide-react";

import type { TodoPriority, TodoRecord } from "../../lib/types";
import { IconButton } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { TodoInlineContentEditor } from "./TodoInlineContentEditor";
import { TodoInlineProgressEditor } from "./TodoInlineProgressEditor";
import { TodoPriorityDropdown } from "./TodoPriorityDropdown";
import {
  formatFullDate,
  formatMonthDay,
  resolveTodoSourceMeta,
  sortTodoProgresses,
} from "./todo-utils";

export function TodoListItem({
  todo,
  isFirst = false,
  activityNameById,
  compact = false,
  allowInlineEdit = false,
  allowInlineProgress = false,
  expanded = false,
  onToggleStatus,
  onUpdatePriority,
  onUpdateContent,
  onAddProgress,
  onOpenTodoSource,
  onToggleExpanded,
  onError,
}: {
  todo: TodoRecord;
  isFirst?: boolean;
  activityNameById: ReadonlyMap<number, string>;
  compact?: boolean;
  allowInlineEdit?: boolean;
  allowInlineProgress?: boolean;
  expanded?: boolean;
  onToggleStatus: (todoId: number, status: TodoRecord["status"]) => Promise<unknown> | void;
  onUpdatePriority: (todoId: number, priority: TodoPriority) => Promise<unknown> | void;
  onUpdateContent: (todoId: number, content: string) => Promise<unknown> | void;
  onAddProgress: (
    todoId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onOpenTodoSource: (todo: TodoRecord) => void;
  onToggleExpanded: (todoId: number) => void;
  onError?: (message: string) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const sortedProgresses = sortTodoProgresses(todo.progresses);
  const latestProgress = sortedProgresses[0] ?? null;
  const previousProgresses = sortedProgresses.slice(1);
  const sourceMeta = resolveTodoSourceMeta(todo.activityId, activityNameById);
  const canExpand = previousProgresses.length > 0;

  async function handleToggle() {
    setToggling(true);
    try {
      await onToggleStatus(todo.id, todo.status === "finished" ? "unfinished" : "finished");
    } finally {
      setToggling(false);
    }
  }

  return (
    <article
      id={`todo-${todo.id}`}
      className={cn(
        "group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-3 transition-[background-color,opacity] duration-[160ms] ease-[var(--ease-soft)]",
        !isFirst && "border-t border-border",
        compact && "py-2.5",
        todo.status === "finished" ? "opacity-72" : "hover:bg-bg-hover",
      )}
    >
      <div className="grid min-w-0 gap-2">
        <TodoInlineContentEditor
          value={todo.content}
          editable={allowInlineEdit}
          onSave={(content) => onUpdateContent(todo.id, content)}
        />

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption leading-4">
          <TodoPriorityDropdown
            priority={todo.priority}
            onSelect={(priority) => onUpdatePriority(todo.id, priority)}
          />
          <span className="text-text-soft">·</span>
          {sourceMeta.kind === "activity" ? (
            <button
              type="button"
              className="max-w-full truncate bg-transparent text-text-soft transition-colors hover:text-text"
              onClick={() => onOpenTodoSource(todo)}
            >
              {sourceMeta.label}
            </button>
          ) : (
            <span className="truncate text-text-soft">{sourceMeta.label}</span>
          )}
        </div>

        <TodoInlineProgressEditor
          latestProgress={
            latestProgress
              ? { content: latestProgress.content, progressDate: latestProgress.progressDate }
              : null
          }
          editable={allowInlineProgress}
          onError={onError}
          onSave={(payload) => onAddProgress(todo.id, payload)}
        />

        {expanded && canExpand ? (
          <div className="mt-1 border-t border-border">
            <div className="grid">
              {previousProgresses.map((progress, index) => (
                <article
                  key={progress.id}
                  className={cn("py-2", index > 0 && "border-t border-border")}
                >
                  <p className="text-ui leading-5 text-text-muted">
                    <span className="break-words">{progress.content}</span>
                    <span
                      className="ml-2 text-caption text-text-soft"
                      title={formatFullDate(progress.progressDate)}
                    >
                      {formatMonthDay(progress.progressDate)}
                    </span>
                  </p>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-0.5 flex self-stretch flex-col items-center gap-1">
        <IconButton
          type="button"
          variant={todo.status === "finished" ? "subtle" : "secondary"}
          size="sm"
          className="rounded-full opacity-70 group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={todo.status === "finished" ? "标记为未完成" : "标记为已完成"}
          disabled={toggling}
          onClick={() => {
            void handleToggle();
          }}
        >
          {todo.status === "finished" ? <Check size={13} /> : <Circle size={13} />}
        </IconButton>
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          className="mt-auto opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={expanded ? "收起历史进展" : "展开历史进展"}
          disabled={!canExpand}
          onClick={() => onToggleExpanded(todo.id)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </IconButton>
      </div>
    </article>
  );
}
