import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Settings2 } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { parseRouteId, projectPath, recordFocusId, workspacePath } from "../../lib/formatters";
import { pageWidthContainerClass, withPageWidthClass } from "../../lib/pageWidth";
import {
  getRenderableRichTextHtml,
  type RichEditorValue,
} from "../rich-editor";
import { renderMarkdownToHtml, richTextHtmlToPlainText } from "../../lib/richTextContent";
import { generateDefaultProjectName } from "../../lib/projectDefaultName";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { resolveTodoContentTagSync, todoTagIds } from "../../lib/todo-tag-sync";
import { colorKeyForTagLabel, extractHashTagLabels, findTagByLabel, mergeUniqueTagIds } from "../../lib/tags";
import { extractTagMentionIds } from "../../lib/tagMentions";
import type { FileTagRecord, TodoPriority } from "../../lib/types";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useWorkspaceQuickNoteMutations } from "../../hooks/useWorkspaceQuickNoteMutations";
import { useTodoMutations } from "../../hooks/useTodoMutations";
import { useWorkspaceRecordMutations } from "../../hooks/useWorkspaceRecordMutations";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import { refreshAll } from "../../hooks/shared";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { desktopApi } from "../../services/desktopApi";
import { cn } from "../../ui/lib/cn";
import { IconButton } from "../../ui/components";
import { RichEditor } from "../rich-editor";
import { TodoRail } from "../todo";
import { WorkspaceOverviewHistory } from "./WorkspaceOverviewHistory";
import { WorkspaceOverviewSidebar } from "./WorkspaceOverviewSidebar";

type WorkspacePageView = "quick-note" | "record";
const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

export function WorkspacePage() {
  const navigate = useNavigate();
  const params = useParams();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pushToast } = useFeedbackStore();
  const {
    openSettings,
    pageWidthMode,
    projectRecentPaths,
    openProjectIds,
    closeProjectTab,
    projectSidebarCollapsed,
    todoRailCollapsed,
  } = useUiStore();
  const openInternalReference = useInternalReferenceNavigation();
  const openContactMention = useContactMentionNavigation();
  const contactMentionOptions = useContactMentionOptions();
  const activeProjectId = parseRouteId(params.projectId);

  const focusId = searchParams.get("focus");
  const focusedRecordId = parseFocusRecordId(focusId);
  const explicitView = parseWorkspacePageView(searchParams.get("view"));
  const composeRecord = searchParams.get("compose") === "record";
  const currentView = explicitView ?? (focusedRecordId !== null ? "record" : "quick-note");

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
  });
  const workspacePageQuery = useQuery({
    queryKey: ["workspace-page"],
    queryFn: projectMindApi.workspacePageGet,
  });
  const workspaceStatusQuery = useQuery({
    queryKey: ["workspace-status"],
    queryFn: projectMindApi.workspaceStatusGet,
  });
  const workspaceTagSettingsQuery = useQuery({
    queryKey: ["file-tag-settings", "workspace"],
    queryFn: () => projectMindApi.fileTagSettingsGet({}),
  });

  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.isArchived),
    [projectsQuery.data],
  );
  const archivedProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => project.isArchived),
    [projectsQuery.data],
  );
  const workspacePage = workspacePageQuery.data;
  const currentWorkspace = workspaceStatusQuery.data?.currentWorkspace ?? null;
  const availableTags = workspaceTagSettingsQuery.data?.tags ?? [];
  const [quickNoteDraft, setQuickNoteDraft] = useState<RichEditorValue>(EMPTY_VALUE);
  const recordSearchQuery = searchParams.get("recordQuery") ?? "";
  const recordFilterTagId = useMemo(() => {
    const value = searchParams.get("recordTag");
    if (!value) {
      return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }, [searchParams]);
  const allTodos = useMemo(
    () => [
      ...(workspacePage?.unfinishedTodos ?? []),
      ...(workspacePage?.finishedTodos ?? []),
    ],
    [workspacePage?.finishedTodos, workspacePage?.unfinishedTodos],
  );
  const { workspaceQuickNoteMutation } = useWorkspaceQuickNoteMutations();
  const { workspaceRecordMutation, workspaceRecordDeleteMutation } = useWorkspaceRecordMutations();
  const { createProjectMutation, archiveMutation, deleteProjectMutation } = useProjectMutations(
    visibleProjects,
    (path, options) => navigate(path, options),
  );
  const {
    todoMutation,
    todoContentMutation,
    todoDeleteMutation,
    todoPriorityMutation,
    todoTagMutation,
    todoProgressMutation,
    todoProgressUpdateMutation,
    todoProgressDeleteMutation,
    todoStatusMutation,
  } = useTodoMutations(allTodos);

  useEffect(() => {
    const quickNote = workspacePage?.quickNote;
    setQuickNoteDraft({
      html: getRenderableRichTextHtml({
        html: quickNote?.contentHtml,
        markdown: quickNote?.contentMarkdown,
      }),
      text: quickNote?.contentMarkdown ?? "",
      markdown: quickNote?.contentMarkdown ?? "",
    });
  }, [workspacePage?.quickNote?.contentHtml, workspacePage?.quickNote?.contentMarkdown]);

  const workspaceRecords = useMemo(() => workspacePage?.records ?? [], [workspacePage?.records]);
  const filteredWorkspaceRecords = useMemo(() => {
    const normalizedQuery = recordSearchQuery.trim().toLowerCase();

    return workspaceRecords.filter((record) => {
      const matchesQuery =
        !normalizedQuery ||
        (record.title ?? "").toLowerCase().includes(normalizedQuery) ||
        record.contentMarkdown.toLowerCase().includes(normalizedQuery) ||
        (record.tags ?? []).some((tag) => tag.label.toLowerCase().includes(normalizedQuery));
      const matchesTag =
        recordFilterTagId === null ||
        (record.tags ?? []).some((tag) => tag.id === recordFilterTagId);

      return matchesQuery && matchesTag;
    });
  }, [recordFilterTagId, recordSearchQuery, workspaceRecords]);
  const visibleRecordFocusKey = useMemo(
    () => filteredWorkspaceRecords.map((record) => record.id).join(","),
    [filteredWorkspaceRecords],
  );

  useFocusTarget(
    focusedRecordId !== null && currentView === "record"
      ? recordFocusId(focusedRecordId)
      : null,
    [currentView, visibleRecordFocusKey],
  );

  const appendSelectionToProjectNoteMutation = useMutation({
    mutationFn: async (input: {
      projectId: number;
      selection: { markdown: string };
    }) => {
      const project = visibleProjects.find((item) => item.id === input.projectId);

      if (!project) {
        throw new Error("目标项目不存在");
      }

      const nextMarkdown = appendMarkdownBlock(
        project.quickNoteMarkdown || project.quickNote,
        input.selection.markdown,
      );
      const nextHtml = renderMarkdownToHtml(nextMarkdown);

      return projectMindApi.projectUpdate({
        projectId: project.id,
        quickNote: richTextHtmlToPlainText(nextHtml, { preserveStructure: true }),
        quickNoteMarkdown: nextMarkdown,
        quickNoteHtml: nextHtml,
        status: project.status,
      });
    },
    onSuccess: async (project) => {
      pushToast({ tone: "success", title: "已追加到项目 QuickNote", detail: project.name });
      await refreshAll(queryClient, project.id);
      await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "追加项目 QuickNote 失败", detail: String(error) });
    },
  });

  async function createTodo(projectId: number, content: string, priority: TodoPriority) {
    const synced = await resolveTodoContentTagSync({
      projectId,
      content,
      explicitTagIds: [],
    });
    await todoMutation.mutateAsync({
      projectId,
      content: synced.content,
      priority,
      tagIds: synced.tagIds,
    });
  }

  async function updateTodoContent(todoId: number, content: string) {
    const currentTodo = allTodos.find((todo) => todo.id === todoId);
    if (!currentTodo) {
      await todoContentMutation.mutateAsync({ todoId, content });
      return;
    }

    const synced = await resolveTodoContentTagSync({
      projectId: currentTodo.projectId,
      content,
      explicitTagIds: todoTagIds(currentTodo.tags),
    });
    await todoContentMutation.mutateAsync({
      todoId,
      content: synced.content,
      tagIds: synced.tagIds,
    });
  }

  async function ensureWorkspaceTagIds(markdown: string, explicitTagIds: number[]) {
    const mentionedTagIds = extractTagMentionIds(markdown);
    const hashLabels = extractHashTagLabels(markdown);
    const hashTagIds: number[] = [];

    for (const label of hashLabels) {
      const existing = findTagByLabel(availableTags, label);
      const tag =
        existing ??
        (await projectMindApi.fileTagOptionUpsert({
          label,
          colorKey: colorKeyForTagLabel(label),
        }));
      hashTagIds.push(tag.id);
    }

    return mergeUniqueTagIds(explicitTagIds, mentionedTagIds, hashTagIds);
  }

  function syncWorkspaceTagCache(tag: FileTagRecord) {
    queryClient.setQueryData<{ tags: FileTagRecord[] } | undefined>(
      ["file-tag-settings", "workspace"],
      (current) => {
        const tags = current?.tags ?? [];
        if (tags.some((item) => item.id === tag.id)) {
          return current ?? { tags };
        }

        return {
          tags: [...tags, tag].sort((left, right) =>
            left.label.localeCompare(right.label, "zh-Hans-CN"),
          ),
        };
      },
    );
  }

  function setWorkspacePageView(nextView: WorkspacePageView) {
    const nextSearchParams = new URLSearchParams(searchParams);

    if (nextView === "quick-note") {
      if (focusedRecordId !== null) {
        nextSearchParams.set("view", "quick-note");
      } else {
        nextSearchParams.delete("view");
      }
    } else {
      nextSearchParams.set("view", "record");
    }

    setSearchParams(nextSearchParams);
  }

  function openRecord(recordId: number) {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("view", "record");
    nextSearchParams.set("focus", `record-${recordId}`);
    nextSearchParams.delete("compose");
    setSearchParams(nextSearchParams);
  }

  function setWorkspaceRecordQuery(value: string) {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (value.trim()) {
      nextSearchParams.set("recordQuery", value);
    } else {
      nextSearchParams.delete("recordQuery");
    }
    setSearchParams(nextSearchParams, { replace: true });
  }

  function setWorkspaceRecordTagId(tagId: number | null) {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (tagId === null) {
      nextSearchParams.delete("recordTag");
    } else {
      nextSearchParams.set("recordTag", String(tagId));
    }
    nextSearchParams.set("view", "record");
    setSearchParams(nextSearchParams);
  }

  async function createWorkspaceRecordInFocus() {
    const record = await workspaceRecordMutation.mutateAsync({
      markdown: "",
      html: "<p></p>",
      tagIds: [],
    });
    await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
    await queryClient.invalidateQueries({ queryKey: ["file-tag-settings", "workspace"] });
    navigate(`/workspace/records/${record.id}`);
  }

  function closeComposeRecord() {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("compose");
    setSearchParams(nextSearchParams);
  }

  async function openProjectInNewWindow(projectId: number) {
    const project = visibleProjects.find((item) => item.id === projectId);
    if (!project) {
      return;
    }

    const route = projectRecentPaths[projectId] ?? projectPath(projectId);
    try {
      await desktopApi.openProjectWindow({
        projectId,
        projectName: project.name,
        route,
      });

      if (openProjectIds.includes(projectId)) {
        closeProjectTab(projectId);

        if (activeProjectId === projectId) {
          navigate(workspacePath());
        }
      }
    } catch (error) {
      pushToast({
        tone: "error",
        title: "打开项目新窗口失败",
        detail: String(error),
      });
    }
  }

  async function openProject(projectId: number) {
    const focused = await desktopApi.focusProjectWindow(projectId);
    if (focused) {
      return;
    }

    navigate(projectPath(projectId));
  }

  async function createProjectQuickly() {
    if (createProjectMutation.isPending) {
      return;
    }

    const nextName = generateDefaultProjectName(
      (projectsQuery.data ?? []).map((project) => project.name),
    );

    await createProjectMutation.mutateAsync({
      name: nextName,
      quickNote: "",
      status: "active",
    });
  }

  async function renameProject(projectId: number, name: string) {
    const project = visibleProjects.find((item) => item.id === projectId);
    if (!project) {
      return;
    }

    await projectMindApi.projectUpdate({
      projectId,
      name,
      quickNote: project.quickNote,
      quickNoteMarkdown: project.quickNoteMarkdown,
      quickNoteHtml: project.quickNoteHtml,
      status: project.status,
    });
    await queryClient.invalidateQueries({ queryKey: ["projects", "all"] });
    await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
  }

  function deleteProject(projectId: number, name: string) {
    if (!window.confirm(`确定删除项目「${name}」？项目目录会移到废纸篓。`)) {
      return;
    }

    deleteProjectMutation.mutate({ projectId });
  }

  if (!workspacePage || !currentWorkspace) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载工作区...
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <WorkspaceOverviewSidebar
        workspaceRootPath={currentWorkspace.rootPath}
        projects={visibleProjects}
        archivedProjects={archivedProjects}
        records={(workspacePage.records ?? []).map((record) => ({
          id: record.id,
          title: record.title,
          contentMarkdown: record.contentMarkdown,
          tags: record.tags ?? [],
          updatedAt: record.updatedAt,
        }))}
        activeRecordId={focusedRecordId}
        recordQuery={recordSearchQuery}
        onRecordQueryChange={setWorkspaceRecordQuery}
        activeRecordTagId={recordFilterTagId}
        onActiveRecordTagIdChange={setWorkspaceRecordTagId}
        onOpenOverview={() => navigate(workspacePath())}
        onOpenProject={(projectId) => {
          void openProject(projectId);
        }}
        onOpenProjectInNewWindow={(projectId) => {
          void openProjectInNewWindow(projectId);
        }}
        onCreateProject={() => {
          void createProjectQuickly();
        }}
        createProjectPending={createProjectMutation.isPending}
        onOpenArchivedProject={(projectId) => {
          void openProject(projectId);
        }}
        onRestoreArchivedProject={(projectId) => {
          archiveMutation.mutate({ projectId, isArchived: false });
        }}
        onRenameProject={(project, name) => renameProject(project.id, name)}
        onArchiveProject={(projectId) => archiveMutation.mutate({ projectId, isArchived: true })}
        onDeleteProject={(project) => deleteProject(project.id, project.name)}
        onOpenRecord={openRecord}
        onCreateRecord={() => void createWorkspaceRecordInFocus()}
      />

      <div className="project-overview-focus flex-1" data-testid="workspace-overview-focus-page">
        <header className="project-overview-focus__chrome">
          <div
            className={cn(
              "project-overview-focus__chrome-inner",
              projectSidebarCollapsed && "project-overview-focus__chrome-inner--dock-left",
              todoRailCollapsed && "project-overview-focus__chrome-inner--dock-right",
            )}
          >
            <div className="project-overview-focus__meta">
              <div className="min-w-0">
                <h1 className="project-overview-focus__title">Workspace</h1>
                <button
                  type="button"
                  className="project-overview-focus__path"
                  onClick={() =>
                    void desktopApi.openFolder(currentWorkspace.rootPath)
                  }
                >
                  {currentWorkspace.rootPath}
                </button>
              </div>
            </div>

            <div className="project-overview-focus__header-actions">
              <IconButton
                type="button"
                size="sm"
                variant="secondary"
                aria-label="打开页面设置"
                title="页面设置"
                onClick={() => openSettings("page-width")}
              >
                <Settings2 size={14} />
              </IconButton>
              <div
                className="project-overview-focus__view-switch"
                data-testid="workspace-overview-view-switch"
              >
                <button
                  type="button"
                  className={cn(
                    "project-overview-focus__view-switch-button",
                    currentView === "quick-note" &&
                      "project-overview-focus__view-switch-button--active",
                  )}
                  data-testid="workspace-page-view-quick-note"
                  aria-pressed={currentView === "quick-note"}
                  onClick={() => setWorkspacePageView("quick-note")}
                >
                  QuickNote
                </button>
                <button
                  type="button"
                  className={cn(
                    "project-overview-focus__view-switch-button",
                    currentView === "record" &&
                      "project-overview-focus__view-switch-button--active",
                  )}
                  data-testid="workspace-page-view-record"
                  aria-pressed={currentView === "record"}
                  onClick={() => setWorkspacePageView("record")}
                >
                  Record
                </button>
              </div>
            </div>
          </div>
        </header>

        <div className="project-overview-focus__scroll" data-testid="workspace-overview-focus-scroll">
          <div
            className={cn(
              "mx-auto w-full",
              currentView === "quick-note"
                ? pageWidthContainerClass(pageWidthMode, "overview")
                : "max-w-none",
            )}
          >
            {currentView === "quick-note" ? (
              <section
                className={withPageWidthClass("project-overview-focus__page", pageWidthMode, "focus")}
                data-testid="workspace-page-body-quick-note"
              >
                <RichEditor
                  html={quickNoteDraft.html}
                  variant="page"
                  showToolbar={false}
                  enableTables={false}
                  placeholder="记下今天最需要先抓住的背景、判断、临时结论或提醒。"
                  tagMentions={{
                    projectId: null,
                    availableTags,
                    onCreateTag: async (label) => {
                      const tag = await projectMindApi.fileTagOptionUpsert({
                        label,
                        colorKey: colorKeyForTagLabel(label),
                      });
                      syncWorkspaceTagCache(tag);
                      return tag;
                    },
                  }}
                  selectionActions={[
                    {
                      key: "workspace-selection-append-project-quick-note",
                      label: "追加到项目 QuickNote",
                      icon: null as never,
                      disabled: visibleProjects.length === 0,
                      onSelect: (selection) => {
                        const targetProjectId = visibleProjects[0]?.id;
                        if (!targetProjectId) {
                          return;
                        }
                        void appendSelectionToProjectNoteMutation.mutateAsync({
                          projectId: targetProjectId,
                          selection,
                        });
                      },
                    },
                  ]}
                  internalReferences={{
                    context: { scope: "workspace" },
                    onOpenReference: openInternalReference,
                  }}
                  contactMentions={contactMentionOptions}
                autosave={{
                  delay: 120000,
                  onBlur: true,
                  onWindowBlur: true,
                  onVisibilityChange: true,
                }}
                  onSave={async (value) => {
                    const tagIds = await ensureWorkspaceTagIds(value.markdown, []);
                    await workspaceQuickNoteMutation.mutateAsync({
                      markdown: value.markdown,
                      html: value.html,
                      tagIds,
                    });
                    await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
                    await queryClient.invalidateQueries({ queryKey: ["file-tag-settings", "workspace"] });
                  }}
                />
              </section>
            ) : (
              <WorkspaceOverviewHistory
                notes={filteredWorkspaceRecords}
                hasAnyNotes={workspaceRecords.length > 0}
                focusId={focusId}
                composeRecord={composeRecord}
                pageWidthMode={pageWidthMode}
                availableTags={availableTags}
                saving={workspaceRecordMutation.isPending}
                onCreateRecord={async (input) => {
                  const tagIds = await ensureWorkspaceTagIds(input.markdown, input.tagIds ?? []);
                  await workspaceRecordMutation.mutateAsync({ ...input, tagIds });
                  await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
                  await queryClient.invalidateQueries({ queryKey: ["file-tag-settings", "workspace"] });
                }}
                onUpdateRecord={async (note, input) => {
                  const tagIds = await ensureWorkspaceTagIds(input.markdown, input.tagIds ?? []);
                  await workspaceRecordMutation.mutateAsync({
                    noteId: note.id,
                    ...input,
                    tagIds,
                  });
                  await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
                  await queryClient.invalidateQueries({ queryKey: ["file-tag-settings", "workspace"] });
                }}
                onDeleteRecord={async (noteId) => {
                  await workspaceRecordDeleteMutation.mutateAsync({ noteId });
                  await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
                  await queryClient.invalidateQueries({ queryKey: ["file-tag-settings", "workspace"] });
                }}
                onCloseCompose={closeComposeRecord}
                contactMentionOptions={contactMentionOptions}
                onOpenInternalReference={openInternalReference as (reference: unknown) => Promise<boolean>}
              />
            )}
          </div>
        </div>
      </div>

      <TodoRail
        title="To Do List"
        scopeLabel="整个工作区"
        unfinishedTodos={workspacePage.unfinishedTodos}
        finishedTodos={workspacePage.finishedTodos}
        createPlaceholder="写下一条需要推进的 Todo，可用 #标签"
        onCreateTodo={(payload) => {
          const fallbackProjectId = visibleProjects[0]?.id;
          if (!fallbackProjectId) return;
          void createTodo(fallbackProjectId, payload.content, payload.priority);
        }}
        onToggleStatus={(todoId, status) =>
          todoStatusMutation.mutateAsync({ todoId, status })
        }
        onUpdatePriority={(todoId, priority) =>
          todoPriorityMutation.mutateAsync({ todoId, priority })
        }
        onUpdateContent={updateTodoContent}
        onUpdateTags={(todoId, tagIds) =>
          todoTagMutation.mutateAsync({ todoId, tagIds })
        }
        onAddProgress={(todoId, payload) =>
          todoProgressMutation.mutateAsync({ todoId, ...payload })
        }
        onUpdateProgress={(progressId, payload) =>
          todoProgressUpdateMutation.mutateAsync({ progressId, ...payload })
        }
        onDeleteProgress={(progressId) =>
          todoProgressDeleteMutation.mutateAsync({ progressId })
        }
        onDeleteTodo={(todoId) => todoDeleteMutation.mutateAsync({ todoId })}
        onError={(message) => {
          pushToast({ tone: "error", title: "Todo 处理失败", detail: message });
        }}
        onOpenInternalReference={openInternalReference}
        onOpenContactMention={openContactMention}
      />
    </div>
  );
}

function parseWorkspacePageView(value: string | null): WorkspacePageView | null {
  if (value === "quick-note" || value === "record") {
    return value;
  }

  return null;
}

function parseFocusRecordId(focus: string | null) {
  const match = focus?.match(/^record-(\d+)$/u);
  return match ? Number(match[1]) : null;
}

function appendMarkdownBlock(existingMarkdown: string | undefined, markdownToAppend: string) {
  const existing = existingMarkdown?.trim() ?? "";
  const addition = markdownToAppend.trim();

  if (!existing) {
    return addition;
  }

  if (!addition) {
    return existing;
  }

  return `${existing}\n\n${addition}`;
}
