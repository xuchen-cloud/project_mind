import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "../lib/queryKeys";
import {
  colorKeyForTagLabel,
  extractHashTagLabels,
  findTagByLabel,
  mergeUniqueTagIds,
  stripHashTagText,
} from "../lib/tags";
import type {
  DocumentTagRecord,
  ProjectListItem,
  ProjectTagRecord,
  TodoCreateInput,
  TodoPriority,
  TodoProgressRecord,
  TodoRecord,
  TodoStatus,
} from "../lib/types";
import { projectMindApi } from "../services/projectMindApi";
import {
  cacheProjectTodoCollection,
  cacheWorkspaceTodoCollections,
  createTodoQueryCache,
  optimisticTodoFromInput,
} from "./todo-cache";

export type TodoViewScope =
  | { kind: "workspace" }
  | { kind: "current-project"; projectId: number };

export interface TodoView {
  kind: TodoViewScope["kind"];
  projectId: number | null;
  projects: ProjectListItem[];
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
}

export type TodoOwnership =
  | { scope: "workspace" }
  | { scope: "project"; projectId: number };

export type TodoChange =
  | {
      type: "create";
      ownership: TodoOwnership;
      content: string;
      priority: TodoPriority;
      dueDate?: string | null;
    }
  | { type: "update-content"; todoId: number; content: string; dueDate?: string | null }
  | { type: "update-priority"; todoId: number; priority: TodoPriority }
  | { type: "update-status"; todoId: number; status: TodoStatus }
  | { type: "update-tags"; todoId: number; tagIds: number[]; tags: DocumentTagRecord[] }
  | {
      type: "add-progress";
      todoId: number;
      content: string;
      progressDate: string;
      dueDate?: string | null;
    }
  | {
      type: "update-progress";
      progressId: number;
      content: string;
      progressDate: string;
      dueDate?: string | null;
      status?: TodoStatus;
    }
  | { type: "delete-progress"; progressId: number }
  | { type: "delete"; todoId: number };

export type TodoTransport = Pick<
  typeof projectMindApi,
  | "projectsList"
  | "workspacePageGet"
  | "projectPageGet"
  | "projectTagSettingsGet"
  | "projectTagUpsert"
  | "todoCreate"
  | "todoUpdateContent"
  | "todoUpdateTags"
  | "todoUpdatePriority"
  | "todoUpdateStatus"
  | "todoAddProgress"
  | "todoUpdateProgress"
  | "todoDeleteProgress"
  | "todoDelete"
>;

export function createTodoModule({
  queryClient,
  transport,
}: {
  queryClient: QueryClient;
  transport: TodoTransport;
}) {
  const cache = createTodoQueryCache(queryClient);
  const todoMutationRevisions = new Map<number, number>();

  async function load(scope: TodoViewScope, options: { force?: boolean } = {}) {
    const readQuery = options.force
      ? queryClient.fetchQuery.bind(queryClient)
      : queryClient.ensureQueryData.bind(queryClient);
    const projectsPromise = readQuery({
      queryKey: queryKeys.projects.all,
      queryFn: () => transport.projectsList({ includeArchived: true }),
    });

    if (scope.kind === "workspace") {
      const [workspacePage] = await Promise.all([
        readQuery({
          queryKey: queryKeys.workspacePage,
          queryFn: () => transport.workspacePageGet(),
        }),
        projectsPromise,
      ]);
      cacheWorkspaceTodoCollections(queryClient, workspacePage);
    } else {
      const [projectPage] = await Promise.all([
        readQuery({
          queryKey: queryKeys.projectPage(scope.projectId),
          queryFn: () => transport.projectPageGet({ projectId: scope.projectId }),
        }),
        projectsPromise,
      ]);
      cacheProjectTodoCollection(queryClient, projectPage);
    }

    return read(scope);
  }

  function read(scope: TodoViewScope): TodoView {
    const projects = (
      queryClient.getQueryData<ProjectListItem[]>(queryKeys.projects.all) ?? []
    ).filter((project) => !project.isArchived);

    if (scope.kind === "workspace") {
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      const activeProjectIds = new Set(projects.map((project) => project.id));
      const todos =
        queryClient.getQueryData<TodoRecord[]>(queryKeys.todoCollections.workspaceRail) ?? [];
      const visibleTodos = todos
        .filter(
          (todo) =>
            todo.scope === "workspace" ||
            (todo.projectId !== null && activeProjectIds.has(todo.projectId)),
        )
        .map((todo) =>
          todo.scope === "project" && todo.projectId !== null
            ? { ...todo, projectName: projectNames.get(todo.projectId) ?? todo.projectName }
            : todo,
        );

      return {
        kind: "workspace",
        projectId: null,
        projects,
        unfinishedTodos: visibleTodos.filter((todo) => todo.status === "unfinished"),
        finishedTodos: visibleTodos.filter((todo) => todo.status === "finished"),
      };
    }

    const todos =
      queryClient.getQueryData<TodoRecord[]>(
        queryKeys.todoCollections.projectOwned(scope.projectId),
      ) ?? [];
    return {
      kind: "current-project",
      projectId: scope.projectId,
      projects,
      unfinishedTodos: todos.filter((todo) => todo.status === "unfinished"),
      finishedTodos: todos.filter((todo) => todo.status === "finished"),
    };
  }

  async function resolveContentTags(
    ownership: TodoOwnership,
    content: string,
    explicitTagIds: number[],
    explicitTags: DocumentTagRecord[] = [],
  ) {
    const tagQueryKey =
      ownership.scope === "workspace"
        ? queryKeys.projectTags.workspace
        : queryKeys.projectTags.project(ownership.projectId);
    let knownTags =
      queryClient.getQueryData<{ tags: ProjectTagRecord[] }>(tagQueryKey)?.tags ?? [];
    const hashTagIds: number[] = [];

    if (extractHashTagLabels(content).length > 0 && knownTags.length === 0) {
      const snapshot = await transport.projectTagSettingsGet(
        ownership.scope === "workspace" ? {} : { projectId: ownership.projectId },
      );
      knownTags = snapshot.tags;
      queryClient.setQueryData(tagQueryKey, snapshot);
    }

    for (const label of extractHashTagLabels(content)) {
      const existing = findTagByLabel(knownTags, label);
      const tag =
        existing ??
        (await transport.projectTagUpsert({
          ...(ownership.scope === "project" ? { projectId: ownership.projectId } : {}),
          label,
          colorKey: colorKeyForTagLabel(label),
        }));
      if (!existing) {
        knownTags = [...knownTags, tag];
        queryClient.setQueryData(tagQueryKey, { tags: knownTags });
      }
      hashTagIds.push(tag.id);
    }

    return {
      content: stripHashTagText(content),
      tagIds: mergeUniqueTagIds(explicitTagIds, hashTagIds),
      tags: [...explicitTags, ...knownTags]
        .filter(
          (tag, index, tags) => tags.findIndex((candidate) => candidate.id === tag.id) === index,
        )
        .filter((tag) => mergeUniqueTagIds(explicitTagIds, hashTagIds).includes(tag.id)),
    };
  }

  function allCachedTodos() {
    const todos = new Map<number, TodoRecord>();
    for (const [, collection] of queryClient.getQueriesData<TodoRecord[]>({
      queryKey: queryKeys.todoCollections.all,
    })) {
      for (const todo of collection ?? []) todos.set(todo.id, todo);
    }
    return [...todos.values()];
  }

  function findTodo(todoId: number) {
    return allCachedTodos().find((todo) => todo.id === todoId);
  }

  function findTodoByProgress(progressId: number) {
    return allCachedTodos().find((todo) =>
      todo.progresses.some((progress) => progress.id === progressId),
    );
  }

  function ownershipOf(todo: TodoRecord): TodoOwnership {
    return todo.scope === "workspace"
      ? { scope: "workspace" }
      : { scope: "project", projectId: todo.projectId as number };
  }

  async function mutateExistingTodo<T>({
    source,
    optimisticTodo,
    run,
    reconcile,
    openTodoDelta = 0,
  }: {
    source: TodoRecord;
    optimisticTodo: TodoRecord;
    run: () => Promise<T>;
    reconcile: (result: T, optimistic: TodoRecord) => TodoRecord | null;
    openTodoDelta?: number;
  }) {
    const mutationRevision = (todoMutationRevisions.get(source.id) ?? 0) + 1;
    todoMutationRevisions.set(source.id, mutationRevision);
    await cache.cancel(source.projectId);
    const snapshot = cache.snapshot(source.projectId);
    cache.upsert(optimisticTodo);
    cache.updateProjectOpenCount(source.projectId, openTodoDelta);
    try {
      const result = await run();
      if (todoMutationRevisions.get(source.id) === mutationRevision) {
        const saved = reconcile(result, optimisticTodo);
        if (saved) cache.upsert(saved);
      }
      return result;
    } catch (error) {
      if (todoMutationRevisions.get(source.id) === mutationRevision) {
        cache.restore(source.projectId, snapshot);
      }
      throw error;
    }
  }

  async function create(command: Extract<TodoChange, { type: "create" }>) {
    const synced = await resolveContentTags(command.ownership, command.content, []);
    const input: TodoCreateInput =
      command.ownership.scope === "workspace"
        ? {
            scope: "workspace",
            projectId: null,
            activityId: null,
            content: synced.content,
            priority: command.priority,
            dueDate: command.dueDate,
            tagIds: synced.tagIds,
          }
        : {
            scope: "project",
            projectId: command.ownership.projectId,
            activityId: null,
            content: synced.content,
            priority: command.priority,
            dueDate: command.dueDate,
            tagIds: synced.tagIds,
          };
    await cache.cancel(input.projectId);
    const snapshot = cache.snapshot(input.projectId);
    const optimisticTodo = {
      ...optimisticTodoFromInput(input),
      tags: synced.tags,
    };
    cache.upsert(optimisticTodo);
    cache.updateProjectOpenCount(input.projectId, 1);

    try {
      const saved = await transport.todoCreate(input);
      cache.remove(optimisticTodo);
      cache.upsert(saved);
      return saved;
    } catch (error) {
      cache.restore(input.projectId, snapshot);
      throw error;
    }
  }

  async function change(command: TodoChange) {
    if (command.type === "create") return create(command);

    if (command.type === "update-content") {
      const source = findTodo(command.todoId);
      if (!source) throw new Error(`Todo ${command.todoId} 不存在`);
      const synced = await resolveContentTags(
        ownershipOf(source),
        command.content,
        (source.tags ?? []).map((tag) => tag.id),
        source.tags ?? [],
      );
      const optimisticTodo = {
        ...source,
        content: synced.content,
        dueDate: command.dueDate ?? null,
        tags: synced.tags,
      };
      return mutateExistingTodo({
        source,
        optimisticTodo,
        run: () =>
          transport.todoUpdateContent({
            todoId: source.id,
            content: synced.content,
            dueDate: command.dueDate,
            tagIds: synced.tagIds,
          }),
        reconcile: (saved) => saved,
      });
    }

    if (command.type === "update-priority") {
      const source = findTodo(command.todoId);
      if (!source) throw new Error(`Todo ${command.todoId} 不存在`);
      return mutateExistingTodo({
        source,
        optimisticTodo: { ...source, priority: command.priority },
        run: () => transport.todoUpdatePriority({ todoId: source.id, priority: command.priority }),
        reconcile: (saved) => saved,
      });
    }

    if (command.type === "update-status") {
      const source = findTodo(command.todoId);
      if (!source) throw new Error(`Todo ${command.todoId} 不存在`);
      const openTodoDelta =
        source.status === command.status ? 0 : command.status === "finished" ? -1 : 1;
      return mutateExistingTodo({
        source,
        optimisticTodo: { ...source, status: command.status },
        openTodoDelta,
        run: () => transport.todoUpdateStatus({ todoId: source.id, status: command.status }),
        reconcile: (saved) => saved,
      });
    }

    if (command.type === "update-tags") {
      const source = findTodo(command.todoId);
      if (!source) throw new Error(`Todo ${command.todoId} 不存在`);
      return mutateExistingTodo({
        source,
        optimisticTodo: { ...source, tags: command.tags },
        run: () => transport.todoUpdateTags({ todoId: source.id, tagIds: command.tagIds }),
        reconcile: (saved) => saved,
      });
    }

    if (command.type === "add-progress") {
      const source = findTodo(command.todoId);
      if (!source) throw new Error(`Todo ${command.todoId} 不存在`);
      const optimisticProgress: TodoProgressRecord = {
        id: -Date.now(),
        todoId: source.id,
        content: command.content,
        progressDate: command.progressDate,
        dueDate: command.dueDate ?? null,
        status: "unfinished",
        completedAt: null,
        orderIndex: source.progresses.length,
        createdAt: new Date().toISOString(),
      };
      return mutateExistingTodo({
        source,
        optimisticTodo: { ...source, progresses: [optimisticProgress, ...source.progresses] },
        run: () =>
          transport.todoAddProgress({
            todoId: source.id,
            content: command.content,
            progressDate: command.progressDate,
            dueDate: command.dueDate,
          }),
        reconcile: (saved, optimistic) => ({
          ...optimistic,
          progresses: [saved, ...optimistic.progresses.filter((progress) => progress.id >= 0)],
        }),
      });
    }

    if (command.type === "update-progress") {
      const source = findTodoByProgress(command.progressId);
      if (!source) throw new Error(`Todo progress ${command.progressId} 不存在`);
      const optimisticTodo = {
        ...source,
        progresses: source.progresses.map((progress) =>
          progress.id === command.progressId
            ? {
                ...progress,
                content: command.content,
                progressDate: command.progressDate,
                dueDate: command.dueDate ?? null,
                status: command.status ?? progress.status,
                completedAt:
                  command.status === "finished"
                    ? progress.completedAt ?? new Date().toISOString()
                    : command.status === "unfinished"
                      ? null
                      : progress.completedAt,
              }
            : progress,
        ),
      };
      return mutateExistingTodo({
        source,
        optimisticTodo,
        run: () =>
          transport.todoUpdateProgress({
            progressId: command.progressId,
            content: command.content,
            progressDate: command.progressDate,
            dueDate: command.dueDate,
            status: command.status,
          }),
        reconcile: (saved, optimistic) => ({
          ...optimistic,
          progresses: optimistic.progresses.map((progress) =>
            progress.id === saved.id ? saved : progress,
          ),
        }),
      });
    }

    if (command.type === "delete-progress") {
      const source = findTodoByProgress(command.progressId);
      if (!source) throw new Error(`Todo progress ${command.progressId} 不存在`);
      return mutateExistingTodo({
        source,
        optimisticTodo: {
          ...source,
          progresses: source.progresses.filter((progress) => progress.id !== command.progressId),
        },
        run: () => transport.todoDeleteProgress({ progressId: command.progressId }),
        reconcile: (_deleted, optimistic) => optimistic,
      });
    }

    const source = findTodo(command.todoId);
    if (!source) throw new Error(`Todo ${command.todoId} 不存在`);
    await cache.cancel(source.projectId);
    const snapshot = cache.snapshot(source.projectId);
    cache.remove(source);
    cache.updateProjectOpenCount(source.projectId, source.status === "unfinished" ? -1 : 0);
    try {
      const deleted = await transport.todoDelete({ todoId: source.id });
      cache.remove(deleted);
      return deleted;
    } catch (error) {
      cache.restore(source.projectId, snapshot);
      throw error;
    }
  }

  return { load, read, change };
}

export const productionTodoTransport: TodoTransport = projectMindApi;
