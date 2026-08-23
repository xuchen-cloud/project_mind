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

const now = "2026-08-06T00:00:00.000Z";

function todo(
  id: number,
  ownership: { scope: "workspace" } | { scope: "project"; projectId: number },
  content: string,
): TodoRecord {
  return {
    id,
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
    unorganizedCount: 0,
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

async function loadedProjectTodoModule(openTodoCount = 1) {
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
    conclusionGroups: [],
    records: [],
    unfinishedTodos: [original],
    finishedTodos: [],
  } satisfies ProjectPageData;
  const transport = testTransport({
    projects: [active],
    workspacePage,
    projectPages: { [active.id]: projectPage },
  });
  const module = createTodoModule({ queryClient: new QueryClient(), transport });
  await module.load({ kind: "workspace" });
  await module.load({ kind: "current-project", projectId: active.id });
  return { active, module, original, transport };
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
      conclusionGroups: [],
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
      conclusionGroups: [],
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

    expect(transport.todoUpdateTags).toHaveBeenCalledWith({ todoId: original.id, tagIds: [12] });
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

    const completedProgress = {
      ...progress,
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

    vi.mocked(transport.todoDeleteProgress).mockResolvedValueOnce(completedProgress);
    await module.change({ type: "delete-progress", progressId: progress.id });
    expect(module.read({ kind: "workspace" }).unfinishedTodos[0].progresses).toEqual([]);
  });

  it("keeps the latest Subtask status when interrupted saves resolve out of order", async () => {
    const { module, original, transport } = await loadedProjectTodoModule();
    const progress = {
      id: 41,
      todoId: original.id,
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
      conclusionGroups: [],
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
