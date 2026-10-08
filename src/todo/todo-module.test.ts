import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type {
  ProjectListItem,
  ProjectPageData,
  TodoProgressRecord,
  TodoRecord,
  WorkspacePageData,
} from "../lib/types";
import { createTodoModule, type TodoTransport } from "./todo-module";
import { cacheWorkspaceTodoCollections, createTodoQueryCache } from "./todo-cache";
import { queryKeys } from "../lib/queryKeys";

const now = "2026-08-06T00:00:00.000Z";

function todo(
  id: number,
  ownership: { scope: "workspace" } | { scope: "project"; projectId: number },
  content: string,
): TodoRecord {
  return {
    id,
    revision: 1,
    scope: ownership.scope,
    projectId: ownership.scope === "project" ? ownership.projectId : null,
    content,
    status: "unfinished",
    priority: "not_urgent_important",
    dueDate: null,
    tags: [],
    createdAt: now,
    updatedAt: now,
    progresses: [],
  };
}

function project(id: number, name: string, isArchived = false): ProjectListItem {
  return {
    id,
    name,
    kind: "normal",
    status: "active",
    rootPath: `/tmp/${name}`,
    quickNote: "",
    isArchived,
    openTodoCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function testTransport(input: {
  projects: ProjectListItem[];
  workspacePage: WorkspacePageData;
  projectPages: Record<number, ProjectPageData>;
}): TodoTransport {
  return {
    projectsList: vi.fn().mockResolvedValue(input.projects),
    workspacePageGet: vi.fn().mockResolvedValue(input.workspacePage),
    projectPageGet: vi.fn(({ projectId }) =>
      Promise.resolve(input.projectPages[projectId]),
    ),
    projectTagSettingsGet: vi.fn().mockResolvedValue({ tags: [] }),
    projectTagUpsert: vi.fn(),
    todoCreate: vi.fn(),
    todoUpdateContent: vi.fn(),
    todoUpdateTags: vi.fn(),
    todoUpdatePriority: vi.fn(),
    todoUpdateStatus: vi.fn(),
    todoAddProgress: vi.fn(),
    todoUpdateProgress: vi.fn(),
    todoDeleteProgress: vi.fn(),
    todoDelete: vi.fn(),
  };
}

async function loadedProjectTodoModule(openTodoCount = 1, queryClient = new QueryClient()) {
  const active = { ...project(1, "Alpha"), openTodoCount };
  const original = todo(30, { scope: "project", projectId: active.id }, "初始内容");
  const workspacePage: WorkspacePageData = {
    quickNote: null,
    records: [],
    unfinishedTodos: [original],
    finishedTodos: [],
  };
  const projectPage = {
    project: active,
    projectDocuments: [],
    records: [],
    unfinishedTodos: [original],
    finishedTodos: [],
  } satisfies ProjectPageData;
  const transport = testTransport({
    projects: [active],
    workspacePage,
    projectPages: { [active.id]: projectPage },
  });
  const module = createTodoModule({ queryClient, transport });
  await module.load({ kind: "workspace" });
  await module.load({ kind: "current-project", projectId: active.id });
  return { active, module, original, transport, queryClient, workspacePage, projectPage };
}

describe("Todo module", () => {
  it("projects the same canonical Todo collection into Workspace View and Current Project View", async () => {
    const active = project(1, "Alpha");
    const archived = project(2, "Archived", true);
    const workspaceTodo = todo(10, { scope: "workspace" }, "Workspace Todo");
    const activeTodo = todo(11, { scope: "project", projectId: active.id }, "Alpha Todo");
    const archivedTodo = todo(
      12,
      { scope: "project", projectId: archived.id },
      "Archived Todo",
    );
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [workspaceTodo, activeTodo, archivedTodo],
      finishedTodos: [],
    };
    const projectPage = {
      project: active,
      projectDocuments: [],
      records: [],
      unfinishedTodos: [activeTodo],
      finishedTodos: [],
    } satisfies ProjectPageData;
    const module = createTodoModule({
      queryClient: new QueryClient(),
      transport: testTransport({
        projects: [active, archived],
        workspacePage,
        projectPages: { [active.id]: projectPage },
      }),
    });

    await module.load({ kind: "workspace" });
    await module.load({ kind: "current-project", projectId: active.id });

    expect(module.read({ kind: "workspace" })).toMatchObject({
      kind: "workspace",
      projects: [active],
      unfinishedTodos: [workspaceTodo, activeTodo],
      finishedTodos: [],
    });
    expect(module.read({ kind: "current-project", projectId: active.id })).toMatchObject({
      kind: "current-project",
      projects: [active],
      unfinishedTodos: [activeTodo],
      finishedTodos: [],
    });
  });

  it("creates a Project Todo optimistically and keeps both views consistent", async () => {
    const active = project(1, "Alpha");
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    };
    const projectPage = {
      project: active,
      projectDocuments: [],
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    } satisfies ProjectPageData;
    const transport = testTransport({
      projects: [active],
      workspacePage,
      projectPages: { [active.id]: projectPage },
    });
    let resolveCreate!: (todo: TodoRecord) => void;
    vi.mocked(transport.todoCreate).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const module = createTodoModule({ queryClient: new QueryClient(), transport });
    await module.load({ kind: "workspace" });
    await module.load({ kind: "current-project", projectId: active.id });

    const createPromise = module.change({
      type: "create",
      ownership: { scope: "project", projectId: active.id },
      content: "发布 Alpha",
      priority: "urgent_important",
    });
    await vi.waitFor(() => {
      expect(transport.todoCreate).toHaveBeenCalledTimes(1);
    });

    expect(module.read({ kind: "workspace" }).unfinishedTodos).toEqual([
      expect.objectContaining({ content: "发布 Alpha", projectId: active.id }),
    ]);
    expect(
      module.read({ kind: "current-project", projectId: active.id }).unfinishedTodos,
    ).toEqual([
      expect.objectContaining({ content: "发布 Alpha", projectId: active.id }),
    ]);
    expect(module.read({ kind: "workspace" }).projects[0].openTodoCount).toBe(1);

    const saved = todo(21, { scope: "project", projectId: active.id }, "发布 Alpha");
    saved.priority = "urgent_important";
    resolveCreate(saved);
    await createPromise;

    expect(module.read({ kind: "workspace" }).unfinishedTodos).toEqual([
      expect.objectContaining(saved),
    ]);
    expect(
      module.read({ kind: "current-project", projectId: active.id }).unfinishedTodos,
    ).toEqual([saved]);
  });

  it("creates a Workspace Todo and resolves hash Tags in the final ownership scope", async () => {
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    };
    const transport = testTransport({
      projects: [],
      workspacePage,
      projectPages: {},
    });
    const tag = {
      id: 9,
      label: "发布",
      colorKey: "blue" as const,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const saved = {
      ...todo(22, { scope: "workspace" }, "准备发布"),
      tags: [tag],
    };
    vi.mocked(transport.projectTagUpsert).mockResolvedValueOnce(tag);
    vi.mocked(transport.todoCreate).mockResolvedValueOnce(saved);
    const module = createTodoModule({ queryClient: new QueryClient(), transport });
    await module.load({ kind: "workspace" });

    await module.change({
      type: "create",
      ownership: { scope: "workspace" },
      content: "准备发布 #发布",
      priority: "not_urgent_important",
    });

    expect(transport.projectTagUpsert).toHaveBeenCalledWith({
      label: "发布",
      colorKey: expect.any(String),
    });
    expect(transport.todoCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "workspace",
        projectId: null,
        content: "准备发布",
        tagIds: [tag.id],
      }),
    );
    expect(module.read({ kind: "workspace" }).unfinishedTodos).toEqual([saved]);
  });

  it("merges explicitly selected Tags with hash Tags while creating", async () => {
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [],
      finishedTodos: [],
    };
    const transport = testTransport({ projects: [], workspacePage, projectPages: {} });
    const explicitTag = {
      id: 8,
      label: "法务",
      colorKey: "red" as const,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const hashTag = {
      id: 9,
      label: "发布",
      colorKey: "blue" as const,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const saved = {
      ...todo(22, { scope: "workspace" }, "准备发布"),
      tags: [explicitTag, hashTag],
    };
    vi.mocked(transport.projectTagSettingsGet).mockResolvedValueOnce({
      tags: [explicitTag, hashTag],
    });
    vi.mocked(transport.todoCreate).mockResolvedValueOnce(saved);
    const module = createTodoModule({ queryClient: new QueryClient(), transport });
    await module.load({ kind: "workspace" });

    await module.change({
      type: "create",
      ownership: { scope: "workspace" },
      content: "准备发布 #发布",
      priority: "not_urgent_important",
      tagIds: [explicitTag.id],
      tags: [explicitTag],
    });

    expect(transport.todoCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "准备发布",
        tagIds: [explicitTag.id, hashTag.id],
      }),
    );
  });

  it("updates Todo content in both projections", async () => {
    const { active, module, original, transport } = await loadedProjectTodoModule();
    const edited = { ...original, content: "更新内容" };
    vi.mocked(transport.todoUpdateContent).mockResolvedValueOnce(edited);
    await module.change({ type: "update-content", todoId: original.id, content: "更新内容" });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].content).toBe("更新内容");
    expect(
      module.read({ kind: "current-project", projectId: active.id }).unfinishedTodos[0].content,
    ).toBe("更新内容");
  });

  it("updates Todo priority in both projections", async () => {
    const { active, module, original, transport } = await loadedProjectTodoModule();
    const prioritized = { ...original, priority: "urgent_important" as const };
    vi.mocked(transport.todoUpdatePriority).mockResolvedValueOnce(prioritized);
    await module.change({
      type: "update-priority",
      todoId: original.id,
      priority: "urgent_important",
    });
    expect(
      module.read({ kind: "current-project", projectId: active.id }).unfinishedTodos[0]
        .priority,
    ).toBe("urgent_important");
  });

  it("updates explicit Todo Tags through the module interface", async () => {
    const { module, original, transport } = await loadedProjectTodoModule();
    const tags = [{ id: 12, label: "法务", colorKey: "red" as const }];
    const tagged = { ...original, tags };
    vi.mocked(transport.todoUpdateTags).mockResolvedValueOnce(tagged);

    await module.change({ type: "update-tags", todoId: original.id, tagIds: [12], tags });

    expect(transport.todoUpdateTags).toHaveBeenCalledWith({ todoId: original.id, expectedRevision: original.revision, tagIds: [12] });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].tags).toEqual(tags);
  });

  it("updates status and the owning Project open-Todo count", async () => {
    const { active, module, original, transport } = await loadedProjectTodoModule(1);
    const finished = { ...original, status: "finished" as const };
    vi.mocked(transport.todoUpdateStatus).mockResolvedValueOnce(finished);
    await module.change({ type: "update-status", todoId: original.id, status: "finished" });
    expect(module.read({ kind: "workspace" }).unfinishedTodos).toEqual([]);
    expect(module.read({ kind: "workspace" }).finishedTodos).toEqual([
      expect.objectContaining(finished),
    ]);
    expect(module.read({ kind: "workspace" }).projects[0].openTodoCount).toBe(0);
    expect(
      module.read({ kind: "current-project", projectId: active.id }).finishedTodos,
    ).toEqual([finished]);
  });

  it("keeps the latest Todo status when interrupted saves resolve out of order", async () => {
    const { module, original, transport } = await loadedProjectTodoModule(1);
    let resolveFinish!: (todo: TodoRecord) => void;
    let resolveUndo!: (todo: TodoRecord) => void;
    vi.mocked(transport.todoUpdateStatus)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFinish = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveUndo = resolve;
      }));

    const finish = module.change({
      type: "update-status",
      todoId: original.id,
      status: "finished",
    });
    await vi.waitFor(() => expect(transport.todoUpdateStatus).toHaveBeenCalledTimes(1));

    const undo = module.change({
      type: "update-status",
      todoId: original.id,
      status: "unfinished",
    });
    await vi.waitFor(() => expect(transport.todoUpdateStatus).toHaveBeenCalledTimes(2));
    expect(module.read({ kind: "workspace" }).unfinishedTodos).toHaveLength(1);

    resolveUndo({ ...original, status: "unfinished" });
    await undo;
    resolveFinish({ ...original, status: "finished" });
    await finish;

    expect(module.read({ kind: "workspace" }).unfinishedTodos).toEqual([
      expect.objectContaining({ id: original.id, status: "unfinished" }),
    ]);
    expect(module.read({ kind: "workspace" }).finishedTodos).toEqual([]);
  });

  it("adds, updates, and deletes Todo progress through one progress lifecycle", async () => {
    const { module, original, transport } = await loadedProjectTodoModule();
    const progress = {
      id: 40,
      todoId: original.id,
      todoRevision: 2,
      content: "第一步",
      progressDate: "2026-08-06",
      dueDate: null,
      status: "unfinished" as const,
      completedAt: null,
      orderIndex: 0,
      createdAt: now,
    };
    vi.mocked(transport.todoAddProgress).mockResolvedValueOnce(progress);
    await module.change({
      type: "add-progress",
      todoId: original.id,
      content: progress.content,
      progressDate: progress.progressDate,
    });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].progresses).toEqual([progress]);
    expect(transport.todoAddProgress).toHaveBeenCalledWith({ todoId: original.id, expectedRevision: original.revision, content: progress.content, progressDate: progress.progressDate, dueDate: undefined });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].revision).toBe(progress.todoRevision);

    const completedProgress = {
      ...progress,
      todoRevision: 7,
      content: "第一步完成",
      status: "finished" as const,
      completedAt: now,
    };
    vi.mocked(transport.todoUpdateProgress).mockResolvedValueOnce(completedProgress);
    await module.change({
      type: "update-progress",
      progressId: progress.id,
      content: completedProgress.content,
      progressDate: progress.progressDate,
      status: "finished",
    });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].progresses).toEqual([
      completedProgress,
    ]);
    expect(transport.todoUpdateProgress).toHaveBeenCalledWith({ progressId: progress.id, expectedRevision: progress.todoRevision, content: completedProgress.content, progressDate: progress.progressDate, dueDate: undefined, status: "finished" });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].revision).toBe(7);

    vi.mocked(transport.todoDeleteProgress).mockResolvedValueOnce({ ...completedProgress, todoRevision: 10 });
    await module.change({ type: "delete-progress", progressId: progress.id });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].progresses).toEqual([]);
    expect(transport.todoDeleteProgress).toHaveBeenCalledWith({ progressId: progress.id, expectedRevision: 7 });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].revision).toBe(10);
  });

  it("keeps the latest Subtask status when interrupted saves resolve out of order", async () => {
    const { module, original, transport } = await loadedProjectTodoModule();
    const progress = {
      id: 41,
      todoId: original.id,
      todoRevision: 2,
      content: "第一步",
      progressDate: "2026-08-06",
      dueDate: null,
      status: "unfinished" as const,
      completedAt: null,
      orderIndex: 0,
      createdAt: now,
    };
    vi.mocked(transport.todoAddProgress).mockResolvedValueOnce(progress);
    await module.change({
      type: "add-progress",
      todoId: original.id,
      content: progress.content,
      progressDate: progress.progressDate,
    });

    let resolveFinish!: (progress: TodoProgressRecord) => void;
    let resolveUndo!: (progress: TodoProgressRecord) => void;
    vi.mocked(transport.todoUpdateProgress)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFinish = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveUndo = resolve;
      }));

    const finish = module.change({
      type: "update-progress",
      progressId: progress.id,
      content: progress.content,
      progressDate: progress.progressDate,
      status: "finished",
    });
    await vi.waitFor(() => expect(transport.todoUpdateProgress).toHaveBeenCalledTimes(1));

    const undo = module.change({
      type: "update-progress",
      progressId: progress.id,
      content: progress.content,
      progressDate: progress.progressDate,
      status: "unfinished",
    });
    await vi.waitFor(() => expect(transport.todoUpdateProgress).toHaveBeenCalledTimes(2));

    resolveUndo(progress);
    await undo;
    resolveFinish({ ...progress, status: "finished", completedAt: now });
    await finish;

    expect(
      module.read({ kind: "workspace" }).unfinishedTodos[0].progresses[0],
    ).toMatchObject({ id: progress.id, status: "unfinished", completedAt: null });
  });

  it("deletes a Todo from both projections and updates the Project count", async () => {
    const { active, module, original, transport } = await loadedProjectTodoModule(1);
    vi.mocked(transport.todoDelete).mockResolvedValueOnce(original);
    await module.change({ type: "delete", todoId: original.id });
    expect(module.read({ kind: "workspace" }).unfinishedTodos).toEqual([]);
    expect(module.read({ kind: "workspace" }).projects[0].openTodoCount).toBe(0);
    expect(
      module.read({ kind: "current-project", projectId: active.id }).unfinishedTodos,
    ).toEqual([]);
  });

  it("rolls back a failed mutation without losing the caller's error", async () => {
    const active = project(1, "Alpha");
    const original = todo(50, { scope: "project", projectId: active.id }, "保留内容");
    const workspacePage: WorkspacePageData = {
      quickNote: null,
      records: [],
      unfinishedTodos: [original],
      finishedTodos: [],
    };
    const projectPage = {
      project: active,
      projectDocuments: [],
      records: [],
      unfinishedTodos: [original],
      finishedTodos: [],
    } satisfies ProjectPageData;
    const transport = testTransport({
      projects: [active],
      workspacePage,
      projectPages: { [active.id]: projectPage },
    });
    const rejection = new Error("Internal Reference 与最终归属不兼容");
    vi.mocked(transport.todoUpdateContent).mockRejectedValueOnce(rejection);
    const module = createTodoModule({ queryClient: new QueryClient(), transport });
    await module.load({ kind: "workspace" });
    await module.load({ kind: "current-project", projectId: active.id });

    await expect(
      module.change({
        type: "update-content",
        todoId: original.id,
        content: "[[todo:99|不兼容]]",
      }),
    ).rejects.toBe(rejection);

    expect(module.read({ kind: "workspace" }).unfinishedTodos).toEqual([
      expect.objectContaining(original),
    ]);
    expect(
      module.read({ kind: "current-project", projectId: active.id }).unfinishedTodos,
    ).toEqual([original]);
  });
});

it("uses cached parent heads for GUI updates and deletes, keeping optimistic create revisions local", async () => {
  const { module, original, transport } = await loadedProjectTodoModule();
  const edited = { ...original, revision: 4, content: "服务返回的新内容" };
  vi.mocked(transport.todoUpdateContent).mockResolvedValueOnce(edited);
  await module.change({ type: "update-content", todoId: original.id, content: edited.content });
  expect(transport.todoUpdateContent).toHaveBeenCalledWith(expect.objectContaining({ todoId: original.id, expectedRevision: original.revision }));
  vi.mocked(transport.todoUpdatePriority).mockResolvedValueOnce({ ...edited, revision: 5 });
  await module.change({ type: "update-priority", todoId: original.id, priority: "urgent_important" });
  expect(transport.todoUpdatePriority).toHaveBeenCalledWith({ todoId: original.id, expectedRevision: 4, priority: "urgent_important" });
  vi.mocked(transport.todoUpdateStatus).mockResolvedValueOnce({ ...edited, revision: 6, status: "finished" });
  await module.change({ type: "update-status", todoId: original.id, status: "finished" });
  expect(transport.todoUpdateStatus).toHaveBeenCalledWith({ todoId: original.id, expectedRevision: 5, status: "finished" });
  vi.mocked(transport.todoDelete).mockResolvedValueOnce({ ...edited, revision: 6 });
  await module.change({ type: "delete", todoId: original.id });
  expect(transport.todoDelete).toHaveBeenCalledWith({ todoId: original.id, expectedRevision: 6 });
});

it.each([
  JSON.stringify({ code: "REVISION_CONFLICT", message: "Stale GUI revision" }),
  { code: "REVISION_CONFLICT", message: "Agent wrote a newer Todo" },
])("refreshes actual affected pages on revision conflict without retry or snapshot rollback: %j", async rejection => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const { module, original, active, transport, workspacePage, projectPage } = await loadedProjectTodoModule(1, client);
  const external = { ...original, revision: 8, content: "Agent 保存的真实内容", priority: "urgent_important" as const };
  vi.mocked(transport.workspacePageGet).mockResolvedValue({ ...workspacePage, unfinishedTodos: [external] });
  vi.mocked(transport.projectPageGet).mockResolvedValue({ ...projectPage, unfinishedTodos: [external] });
  vi.mocked(transport.todoUpdateContent).mockRejectedValueOnce(rejection);
  await expect(module.change({ type: "update-content", todoId: original.id, content: "过期 GUI 内容" })).rejects.toBe(rejection);
  expect(transport.todoUpdateContent).toHaveBeenCalledTimes(1);
  expect(transport.workspacePageGet).toHaveBeenCalledTimes(2);
  expect(transport.projectPageGet).toHaveBeenCalledTimes(2);
  expect(module.read({ kind: "workspace" }).unfinishedTodos).toEqual([expect.objectContaining(external)]);
  expect(module.read({ kind: "current-project", projectId: active.id }).unfinishedTodos).toEqual([external]);
});

it("does not overwrite a newer Agent head when a stale GUI response arrives", async () => {
  const { module, original, transport, queryClient, workspacePage } = await loadedProjectTodoModule();
  let finish!: (todo: TodoRecord) => void;
  vi.mocked(transport.todoUpdateContent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const save = module.change({ type: "update-content", todoId: original.id, content: "GUI 请求" });
  await vi.waitFor(() => expect(transport.todoUpdateContent).toHaveBeenCalledOnce());
  const newer = { ...original, revision: 9, content: "Agent 随后保存" };
  cacheWorkspaceTodoCollections(queryClient, { ...workspacePage, unfinishedTodos: [newer] });
  finish({ ...original, revision: 2, content: "较早 GUI 保存" });
  await save;
  expect(module.read({ kind: "workspace" }).unfinishedTodos[0]).toMatchObject(newer);
  expect(module.read({ kind: "current-project", projectId: 1 }).unfinishedTodos[0]).toMatchObject(newer);
});

it("keeps another Todo's success when this Todo fails and rolls back only its own row", async () => {
  const { module, original, transport, queryClient } = await loadedProjectTodoModule();
  const another = { ...original, id: 31, content: "另一个 Todo" };
  createTodoQueryCache(queryClient).upsert(another);
  let fail!: (error: Error) => void;
  vi.mocked(transport.todoUpdateContent).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockResolvedValueOnce({ ...another, revision: 2, content: "另一个已成功" });
  const rejection = new Error("输入校验失败");
  const first = module.change({ type: "update-content", todoId: original.id, content: "将失败" });
  const expectation = expect(first).rejects.toBe(rejection);
  await vi.waitFor(() => expect(transport.todoUpdateContent).toHaveBeenCalledOnce());
  await module.change({ type: "update-content", todoId: another.id, content: "另一个已成功" });
  fail(rejection); await expectation;
  const todos = module.read({ kind: "workspace" }).unfinishedTodos;
  expect(todos.find(todo => todo.id === original.id)).toMatchObject(original);
  expect(todos.find(todo => todo.id === another.id)).toMatchObject({ revision: 2, content: "另一个已成功" });
});

it("keeps the newer canonical head when an older page refresh finishes", async () => {
  const { module, original, transport, queryClient, workspacePage } = await loadedProjectTodoModule();
  let finish!: (page: WorkspacePageData) => void;
  vi.mocked(transport.workspacePageGet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const refresh = module.load({ kind: "workspace" }, { force: true });
  await vi.waitFor(() => expect(transport.workspacePageGet).toHaveBeenCalledTimes(2));
  const newer = { ...original, revision: 5, content: "刷新期间另一 GUI 已保存" };
  createTodoQueryCache(queryClient).upsert(newer);
  finish(workspacePage); await refresh;
  expect(module.read({ kind: "workspace" }).unfinishedTodos[0]).toMatchObject(newer);
  expect(queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage)?.unfinishedTodos[0]).toMatchObject(newer);
});

it("protects newer parent and subitems when an old subitem response finishes", async () => {
  const { module, original, transport, queryClient } = await loadedProjectTodoModule();
  const progress: TodoProgressRecord = { id: 40, todoId: original.id, todoRevision: 1, content: "原子项", progressDate: "2026-08-06", createdAt: now };
  createTodoQueryCache(queryClient).upsert({ ...original, progresses: [progress] });
  let finish!: (saved: TodoProgressRecord) => void;
  vi.mocked(transport.todoUpdateProgress).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const save = module.change({ type: "update-progress", progressId: progress.id, content: "旧 GUI 修改", progressDate: progress.progressDate });
  await vi.waitFor(() => expect(transport.todoUpdateProgress).toHaveBeenCalledOnce());
  const external = { ...original, revision: 6, content: "Agent 更新父 Todo", progresses: [{ ...progress, todoRevision: 6, content: "Agent 更新子项" }] };
  createTodoQueryCache(queryClient).upsert(external);
  finish({ ...progress, todoRevision: 2, content: "较早 GUI 子项" }); await save;
  expect(module.read({ kind: "workspace" }).unfinishedTodos[0]).toMatchObject(external);
});

it("removes stale subitems after a delete conflict refresh without retrying the delete", async () => {
  const { module, original, transport, queryClient, workspacePage, projectPage } = await loadedProjectTodoModule();
  const progress: TodoProgressRecord = { id: 40, todoId: original.id, todoRevision: 1, content: "过期子项", progressDate: "2026-08-06", createdAt: now };
  createTodoQueryCache(queryClient).upsert({ ...original, progresses: [progress] });
  const rejection = JSON.stringify({ code: "REVISION_CONFLICT", message: "Agent already removed the subitem" });
  const external = { ...original, revision: 4, progresses: [] };
  vi.mocked(transport.workspacePageGet).mockResolvedValue({ ...workspacePage, unfinishedTodos: [external] });
  vi.mocked(transport.projectPageGet).mockResolvedValue({ ...projectPage, unfinishedTodos: [external] });
  vi.mocked(transport.todoDeleteProgress).mockRejectedValueOnce(rejection);
  await expect(module.change({ type: "delete-progress", progressId: 40 })).rejects.toBe(rejection);
  expect(transport.todoDeleteProgress).toHaveBeenCalledOnce();
  expect(transport.todoDeleteProgress).toHaveBeenCalledWith({ progressId: 40, expectedRevision: 1 });
  expect(module.read({ kind: "workspace" }).unfinishedTodos[0]).toMatchObject({ revision: 4, progresses: [] });
});

it("keeps a newer Agent row on ordinary GUI failure and restores its count from the current Todo collection", async () => {
  const { module, original, transport, queryClient } = await loadedProjectTodoModule();
  let fail!: (error: Error) => void;
  vi.mocked(transport.todoUpdateStatus).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const rejection = new Error("写入失败");
  const save = module.change({ type: "update-status", todoId: original.id, status: "finished" });
  const expectation = expect(save).rejects.toBe(rejection);
  await vi.waitFor(() => expect(transport.todoUpdateStatus).toHaveBeenCalledOnce());
  const external = { ...original, revision: 5, content: "Agent 保存" };
  createTodoQueryCache(queryClient).upsert(external);
  fail(rejection); await expectation;
  expect(module.read({ kind: "workspace" }).unfinishedTodos[0]).toMatchObject(external);
  expect(module.read({ kind: "workspace" }).projects[0].openTodoCount).toBe(1);
});

it("reports failed conflict refresh without retrying or restoring an obsolete snapshot", async () => {
  const { module, original, transport } = await loadedProjectTodoModule();
  vi.mocked(transport.todoUpdateContent).mockRejectedValueOnce(JSON.stringify({ code: "REVISION_CONFLICT" }));
  vi.mocked(transport.workspacePageGet).mockRejectedValueOnce(new Error("刷新断开"));
  await expect(module.change({ type: "update-content", todoId: original.id, content: "过期内容" })).rejects.toThrow("刷新最新数据失败");
  expect(transport.todoUpdateContent).toHaveBeenCalledOnce();
  expect(transport.workspacePageGet).toHaveBeenCalledTimes(2);
});
