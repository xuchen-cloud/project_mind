import type { ContactMentionTarget } from "../lib/contactMentions";
import type { InternalReferenceTarget } from "../lib/internalReferences";
import type { ProjectTagRecord } from "../lib/types";
import { useFeedbackStore } from "../state/feedback-store";
import { TodoRail } from "../components/todo";
import type { TodoViewScope } from "./todo-module";
import { useTodoModule } from "./use-todo-module";

export function TodoModuleRail({
  scope,
  enabled = true,
  focusTodoId = null,
  availableTags = [],
  showViewModeSwitch = false,
  canCreateTodo = true,
  onViewModeChange,
  onOpenInternalReference,
  onOpenContactMention,
}: {
  scope: TodoViewScope;
  enabled?: boolean;
  focusTodoId?: number | null;
  availableTags?: ProjectTagRecord[];
  showViewModeSwitch?: boolean;
  canCreateTodo?: boolean;
  onViewModeChange?: (mode: "workspace" | "current-project") => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
}) {
  const todo = useTodoModule(scope, enabled);
  const { pushToast } = useFeedbackStore();
  const viewMode = scope.kind === "workspace" ? "workspace" : "current-project";

  return (
    <TodoRail
      projectId={scope.kind === "current-project" ? scope.projectId : undefined}
      focusTodoId={focusTodoId}
      title="Todo List"
      scopeLabel={scope.kind === "workspace" ? "整个工作区" : "当前 Project"}
      viewMode={viewMode}
      showViewModeSwitch={showViewModeSwitch}
      canCreateTodo={canCreateTodo}
      onViewModeChange={onViewModeChange}
      unfinishedTodos={todo.view.unfinishedTodos}
      finishedTodos={todo.view.finishedTodos}
      availableTags={availableTags}
      canCreateTagsForTodo={() => true}
      createPlaceholder="写下一条需要推进的 Todo，可用 #标签"
      createOwnershipOptions={
        scope.kind === "workspace"
          ? todo.view.projects.map((project) => ({ projectId: project.id, name: project.name }))
          : undefined
      }
      onCreateTodo={(payload) =>
        todo.change({
          type: "create",
          ownership:
            scope.kind === "current-project"
              ? { scope: "project", projectId: scope.projectId }
              : payload.projectId == null
                ? { scope: "workspace" }
                : { scope: "project", projectId: payload.projectId },
          content: payload.content,
          priority: payload.priority,
          dueDate: payload.dueDate,
          tagIds: payload.tagIds,
          tags: payload.optimisticTags,
        })
      }
      onToggleStatus={(todoId, status) =>
        todo.change({ type: "update-status", todoId, status })
      }
      onUpdatePriority={(todoId, priority) =>
        todo.change({ type: "update-priority", todoId, priority })
      }
      onUpdateContent={(todoId, content, dueDate) =>
        todo.change({ type: "update-content", todoId, content, dueDate })
      }
      onUpdateTags={({ todoId, tagIds, optimisticTags }) =>
        todo.change({ type: "update-tags", todoId, tagIds, tags: optimisticTags })
      }
      onAddProgress={(todoId, payload) =>
        todo.change({ type: "add-progress", todoId, ...payload })
      }
      onUpdateProgress={(progressId, payload) =>
        todo.change({ type: "update-progress", progressId, ...payload })
      }
      onDeleteProgress={(progressId) => todo.change({ type: "delete-progress", progressId })}
      onDeleteTodo={(todoId) => todo.change({ type: "delete", todoId })}
      onRefresh={() => todo.refresh()}
      refreshing={todo.refreshing}
      onError={(message) =>
        pushToast({ tone: "error", title: "Todo 处理失败", detail: message })
      }
      onOpenInternalReference={onOpenInternalReference}
      onOpenContactMention={onOpenContactMention}
    />
  );
}
