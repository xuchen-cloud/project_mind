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

  async function createTodo(
    ownership: { scope: "workspace" } | { scope: "project"; projectId: number },
    content: string,
    priority: TodoPriority,
    dueDate?: string | null,
  ) {
    const synced = await resolveTodoContentTagSync({
      tagScope: ownership,
      content,
      explicitTagIds: [],
      availableTags:
        ownership.scope === "workspace" ? availableWorkspaceTags : [],
    });
    await mutations.todoMutation.mutateAsync({
      ...(ownership.scope === "workspace"
        ? { scope: "workspace" as const, projectId: null }
        : { scope: "project" as const, projectId: ownership.projectId }),
      activityId: null,
      content: synced.content,
      priority,
      dueDate,
      tagIds: synced.tagIds,
    });
  }

  async function createWorkspaceTodo(
    content: string,
    priority: TodoPriority,
    dueDate?: string | null,
  ) {
    await createTodo({ scope: "workspace" }, content, priority, dueDate);
  }

  async function createProjectTodo(
    projectId: number,
    content: string,
    priority: TodoPriority,
    dueDate?: string | null,
  ) {
    await createTodo({ scope: "project", projectId }, content, priority, dueDate);
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
    createProjectTodo,
    updateWorkspaceRailTodoContent,
  };
}
