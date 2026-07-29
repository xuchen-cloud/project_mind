import { resolveTodoContentTagSync, todoTagIds } from "../lib/todo-tag-sync";
import type {
  ProjectTagRecord,
  TodoPriority,
  TodoRecord,
} from "../lib/types";
import { useTodoMutations } from "./useTodoMutations";

export function useWorkspaceTodoActions(
  allTodos: TodoRecord[],
  availableWorkspaceTags: ProjectTagRecord[],
) {
  const mutations = useTodoMutations(allTodos);

  async function createWorkspaceTodo(
    content: string,
    priority: TodoPriority,
    dueDate?: string | null,
  ) {
    const synced = await resolveTodoContentTagSync({
      tagScope: { scope: "workspace" },
      content,
      explicitTagIds: [],
      availableTags: availableWorkspaceTags,
    });
    await mutations.todoMutation.mutateAsync({
      scope: "workspace",
      projectId: null,
      activityId: null,
      content: synced.content,
      priority,
      dueDate,
      tagIds: synced.tagIds,
    });
  }

  async function updateWorkspaceRailTodoContent(
    todoId: number,
    content: string,
    dueDate?: string | null,
  ) {
    const currentTodo = allTodos.find((todo) => todo.id === todoId);
    if (!currentTodo) {
      await mutations.todoContentMutation.mutateAsync({
        todoId,
        content,
        dueDate,
      });
      return;
    }

    const isWorkspaceTodo = currentTodo.scope === "workspace";
    const synced = await resolveTodoContentTagSync({
      tagScope: isWorkspaceTodo
        ? { scope: "workspace" }
        : { scope: "project", projectId: currentTodo.projectId! },
      content,
      explicitTagIds: todoTagIds(currentTodo.tags),
      availableTags: isWorkspaceTodo ? availableWorkspaceTags : [],
    });
    await mutations.todoContentMutation.mutateAsync({
      todoId,
      content: synced.content,
      dueDate,
      tagIds: synced.tagIds,
    });
  }

  return {
    ...mutations,
    createWorkspaceTodo,
    updateWorkspaceRailTodoContent,
  };
}
