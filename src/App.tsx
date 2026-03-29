import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  CircleUser,
  Clock3,
  FilePlus2,
  FileText,
  FolderInput,
  FolderKanban,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  Share2,
  Sparkles,
  Star,
  StarOff,
  Target,
} from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { RichTextEditor } from "./components/RichTextEditor";
import { api, pickDirectory, pickFile, revealPath } from "./lib/api";
import type {
  ActivityCardData,
  ActivityCreateInput,
  ActivityDigest,
  ActivityUpdateMetaInput,
  AiSuggestionRecord,
  ConclusionCreateInput,
  ConclusionGroup,
  ConclusionRecord,
  DocumentRecord,
  ProjectListItem,
  ProjectOverviewData,
  TodoRecord,
  WorkspaceSearchResult,
} from "./lib/types";
import { useAppStore } from "./state/app-store";

const PROJECT_STATUS_OPTIONS = [
  { value: "active", label: "进行中" },
  { value: "paused", label: "暂缓" },
  { value: "completed", label: "已完成" },
];

const ACTIVITY_CATEGORY_OPTIONS = [
  { value: "product", label: "PRODUCT" },
  { value: "legal", label: "LEGAL" },
  { value: "engineering", label: "ENGINEERING" },
  { value: "planning", label: "PLANNING" },
  { value: "meeting", label: "MEETING" },
  { value: "finance", label: "FINANCE" },
  { value: "accounting", label: "ACCOUNTING" },
  { value: "operations", label: "OPERATIONS" },
  { value: "compliance", label: "COMPLIANCE" },
  { value: "reporting", label: "REPORTING" },
  { value: "other", label: "OTHER" },
];

const TODO_STATUS_OPTIONS = [
  { value: "todo", label: "未开始" },
  { value: "doing", label: "进行中" },
  { value: "blocked", label: "阻塞" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
] as const;

const TODO_PRIORITY_OPTIONS = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
] as const;

const DOCUMENT_ROLE_OPTIONS = [
  { value: "reference_material", label: "参考资料" },
  { value: "key_material", label: "关键资料" },
] as const;

export default function App() {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const projectId = parseRouteId(params.projectId);
  const activityId = parseRouteId(params.activityId);
  const focusId = searchParams.get("focus");

  const {
    createProjectOpen,
    createActivityOpen,
    activeTodoId,
    toasts,
    setCreateProjectOpen,
    setCreateActivityOpen,
    setActiveTodoId,
    pushToast,
    dismissToast,
  } = useAppStore();

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => api.projectsList({ includeArchived: true }),
  });

  const activeProject = useMemo(
    () => (projectsQuery.data ?? []).find((project) => project.id === projectId) ?? null,
    [projectId, projectsQuery.data],
  );

  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.isArchived),
    [projectsQuery.data],
  );

  const archivedProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => project.isArchived),
    [projectsQuery.data],
  );

  useEffect(() => {
    if (projectsQuery.isLoading) {
      return;
    }

    if ((projectsQuery.data ?? []).length === 0) {
      setCreateProjectOpen(true);
      return;
    }

    if (projectId === null) {
      const fallback = visibleProjects[0] ?? projectsQuery.data?.[0];
      if (fallback) {
        navigate(projectPath(fallback.id), { replace: true });
      }
      return;
    }

    if (!activeProject) {
      const fallback = visibleProjects[0] ?? projectsQuery.data?.[0];
      if (fallback) {
        navigate(projectPath(fallback.id), { replace: true });
      }
    }
  }, [
    activeProject,
    navigate,
    projectId,
    projectsQuery.data,
    projectsQuery.isLoading,
    setCreateProjectOpen,
    visibleProjects,
  ]);

  useEffect(() => {
    if ((projectsQuery.data ?? []).length > 0) {
      setCreateProjectOpen(false);
    }
  }, [projectsQuery.data, setCreateProjectOpen]);

  useEffect(() => {
    if (toasts.length === 0) {
      return;
    }
    const timers = toasts.map((toast) =>
      window.setTimeout(() => dismissToast(toast.id), 4200),
    );
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [dismissToast, toasts]);

  const overviewQuery = useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => api.projectGetOverview({ projectId: projectId as number }),
    enabled: projectId !== null,
  });

  const activitiesQuery = useQuery({
    queryKey: ["activities", projectId],
    queryFn: () => api.activityList({ projectId: projectId as number }),
    enabled: projectId !== null && activityId !== null,
  });

  const currentActivity = useMemo(() => {
    if (!activityId) {
      return null;
    }
    return (activitiesQuery.data ?? []).find((item) => item.id === activityId) ?? null;
  }, [activitiesQuery.data, activityId]);

  const allTodos = useMemo(() => {
    const map = new Map<number, TodoRecord>();
    for (const todo of overviewQuery.data?.unfinishedTodos ?? []) {
      map.set(todo.id, todo);
    }
    for (const todo of overviewQuery.data?.finishedTodos ?? []) {
      map.set(todo.id, todo);
    }
    for (const activity of activitiesQuery.data ?? []) {
      for (const todo of activity.todos) {
        map.set(todo.id, todo);
      }
    }
    return Array.from(map.values());
  }, [activitiesQuery.data, overviewQuery.data?.finishedTodos, overviewQuery.data?.unfinishedTodos]);

  const activeTodo =
    activeTodoId === null
      ? null
      : allTodos.find((todo) => todo.id === activeTodoId) ?? null;

  useEffect(() => {
    if (activeTodoId !== null && !activeTodo) {
      setActiveTodoId(null);
    }
  }, [activeTodo, activeTodoId, setActiveTodoId]);

  const createProjectMutation = useMutation({
    mutationFn: api.projectCreate,
    onSuccess: async (project) => {
      pushToast({ tone: "success", title: "项目已创建", detail: project.name });
      setCreateProjectOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["projects", "all"] });
      navigate(projectPath(project.id));
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "创建项目失败", detail: String(error) });
    },
  });

  const summaryMutation = useMutation({
    mutationFn: api.projectUpdateSummary,
    onSuccess: async (_, input) => {
      pushToast({ tone: "success", title: "项目摘要已保存" });
      await refreshProjectScope(queryClient, input.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "保存摘要失败", detail: String(error) });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: api.projectSetArchive,
    onSuccess: async (project) => {
      pushToast({
        tone: "success",
        title: project.isArchived ? "项目已归档" : "项目已恢复",
        detail: project.name,
      });
      await queryClient.invalidateQueries({ queryKey: ["projects", "all"] });
      await queryClient.invalidateQueries({ queryKey: ["overview", project.id] });
      if (project.isArchived) {
        const nextProject = visibleProjects.find((item) => item.id !== project.id);
        if (nextProject) {
          navigate(projectPath(nextProject.id));
        }
      } else {
        navigate(projectPath(project.id));
      }
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "更新归档状态失败", detail: String(error) });
    },
  });

  const createActivityMutation = useMutation({
    mutationFn: api.activityCreate,
    onSuccess: async (activity) => {
      pushToast({ tone: "success", title: "活动已创建" });
      setCreateActivityOpen(false);
      await refreshProjectScope(queryClient, activity.projectId);
      navigate(activityPath(activity.projectId, activity.id));
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "创建活动失败", detail: String(error) });
    },
  });

  const activityMetaMutation = useMutation({
    mutationFn: api.activityUpdateMeta,
    onSuccess: async (activity) => {
      await refreshProjectScope(queryClient, activity.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "活动更新失败", detail: String(error) });
    },
  });

  const quickNoteMutation = useMutation({
    mutationFn: api.noteAppendQuick,
    onSuccess: async (note) => {
      pushToast({ tone: "success", title: "Quick note 已记录" });
      await refreshProjectScope(queryClient, note.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "记录 quick note 失败", detail: String(error) });
    },
  });

  const minutesMutation = useMutation({
    mutationFn: api.noteUpsertMinutes,
    onSuccess: async (note) => {
      pushToast({ tone: "success", title: "会议纪要已保存" });
      await refreshProjectScope(queryClient, note.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "保存纪要失败", detail: String(error) });
    },
  });

  const conclusionMutation = useMutation({
    mutationFn: api.conclusionCreate,
    onSuccess: async (conclusion) => {
      pushToast({ tone: "success", title: "结论已保存" });
      await refreshProjectScope(queryClient, conclusion.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "新增结论失败", detail: String(error) });
    },
  });

  const conclusionUpdateMutation = useMutation({
    mutationFn: api.conclusionUpdate,
    onSuccess: async (conclusion) => {
      pushToast({ tone: "success", title: "结论已更新" });
      await refreshProjectScope(queryClient, conclusion.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "更新结论失败", detail: String(error) });
    },
  });

  const todoMutation = useMutation({
    mutationFn: api.todoCreate,
    onSuccess: async (todo) => {
      pushToast({ tone: "success", title: "待办已创建", detail: todo.title });
      await refreshProjectScope(queryClient, todo.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "新增待办失败", detail: String(error) });
    },
  });

  const todoStatusMutation = useMutation({
    mutationFn: api.todoUpdateStatus,
    onSuccess: async (todo) => {
      pushToast({ tone: "success", title: "待办状态已更新" });
      await refreshProjectScope(queryClient, todo.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "更新待办失败", detail: String(error) });
    },
  });

  const todoProgressMutation = useMutation({
    mutationFn: api.todoAddProgress,
    onSuccess: async (_, variables) => {
      const source = allTodos.find((todo) => todo.id === variables.todoId);
      if (!source) {
        return;
      }
      pushToast({ tone: "success", title: "进展已追加" });
      await refreshProjectScope(queryClient, source.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "追加进展失败", detail: String(error) });
    },
  });

  const documentImportMutation = useMutation({
    mutationFn: api.documentImport,
    onSuccess: async (document) => {
      pushToast({ tone: "success", title: "文件已导入", detail: document.name });
      await refreshProjectScope(queryClient, document.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "导入文件失败", detail: String(error) });
    },
  });

  const documentMetaMutation = useMutation({
    mutationFn: api.documentUpdateMeta,
    onSuccess: async (document) => {
      await refreshProjectScope(queryClient, document.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "更新文件失败", detail: String(error) });
    },
  });

  const documentRelocateMutation = useMutation({
    mutationFn: api.documentRelocate,
    onSuccess: async (document) => {
      pushToast({ tone: "success", title: "文件已重新定位", detail: document.name });
      await refreshProjectScope(queryClient, document.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "重新定位失败", detail: String(error) });
    },
  });

  const aiGenerateMutation = useMutation({
    mutationFn: api.aiGenerateNoteSuggestions,
    onSuccess: async (suggestions, input) => {
      pushToast({
        tone: "success",
        title: "AI 建议已生成",
        detail: `生成 ${suggestions.length} 条候选项`,
      });
      await refreshProjectScope(queryClient, input.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "AI 建议生成失败", detail: String(error) });
    },
  });

  const aiAcceptMutation = useMutation({
    mutationFn: api.aiAcceptSuggestion,
    onSuccess: async (result) => {
      pushToast({
        tone: "success",
        title: "AI 建议已采纳",
        detail: result.entityKind,
      });
      await refreshProjectScope(queryClient, result.suggestion.projectId);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "采纳建议失败", detail: String(error) });
    },
  });

  const [searchInput, setSearchInput] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(searchInput.trim(), 150);

  const searchQuery = useQuery({
    queryKey: ["workspace-search", debouncedSearch],
    queryFn: () =>
      api.workspaceSearch({
        query: debouncedSearch,
        includeArchived: true,
      }),
    enabled: debouncedSearch.length > 0,
  });

  const searchGroups = useMemo(
    () => groupSearchResults(searchQuery.data ?? []),
    [searchQuery.data],
  );

  const handleOpenTodo = (todoId: number | null) => {
    setActiveTodoId(todoId);
  };

  const handleSearchSelect = (result: WorkspaceSearchResult) => {
    setSearchInput("");
    if (result.kind === "todo") {
      handleOpenTodo(result.id);
    }
    if (result.activityId) {
      navigate(activityPath(result.projectId, result.activityId, `${result.kind}-${result.id}`));
      return;
    }
    navigate(projectPath(result.projectId, `${result.kind}-${result.id}`));
  };

  const showEmptyWorkspace = !projectsQuery.isLoading && (projectsQuery.data ?? []).length === 0;
  const showOverview = activeProject && activityId === null;
  const showActivity = activeProject && activityId !== null;

  return (
    <div className="workspace-app">
      <WorkspaceTopBar
        projects={visibleProjects}
        activeProjectId={projectId}
        archivedProjects={archivedProjects}
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        searchGroups={searchGroups}
        searching={searchQuery.isFetching}
        archiveOpen={archiveOpen}
        onToggleArchive={() => setArchiveOpen((open) => !open)}
        onCloseArchive={() => setArchiveOpen(false)}
        onOpenProject={(nextProjectId) => navigate(projectPath(nextProjectId))}
        onRestoreProject={(nextProjectId) =>
          archiveMutation.mutate({ projectId: nextProjectId, isArchived: false })
        }
        onCreateProject={() => setCreateProjectOpen(true)}
        onSearchSelect={handleSearchSelect}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <main className="workspace-shell">
        {showEmptyWorkspace ? (
          <EmptyWorkspace onCreate={() => setCreateProjectOpen(true)} />
        ) : showOverview && activeProject && overviewQuery.data ? (
          <ProjectOverviewPage
            project={activeProject}
            overview={overviewQuery.data}
            loading={overviewQuery.isLoading}
            createActivityOpen={createActivityOpen}
            projectMenuOpen={projectMenuOpen}
            focusId={focusId}
            onToggleProjectMenu={() => setProjectMenuOpen((open) => !open)}
            onCloseProjectMenu={() => setProjectMenuOpen(false)}
            onCreateActivityToggle={setCreateActivityOpen}
            onCreateActivity={(input) => createActivityMutation.mutate(input)}
            onSaveSummary={(input) => summaryMutation.mutate(input)}
            onImportProjectDocument={async () => {
              const path = await pickFile();
              if (!path) {
                return;
              }
              documentImportMutation.mutate({
                projectId: activeProject.id,
                sourcePath: path,
                role: "key_material",
                isStarred: true,
                promotedToProject: true,
              });
            }}
            onUpdateConclusion={(conclusionId, content, promotedToProject) =>
              conclusionUpdateMutation.mutate({
                conclusionId,
                content,
                promotedToProject,
              })
            }
            onCreateProjectTodo={(payload) =>
              todoMutation.mutate({
                projectId: activeProject.id,
                title: payload.title,
                description: payload.description,
                priority: payload.priority,
                dueDate: payload.dueDate,
              })
            }
            onOpenActivity={(nextActivityId) =>
              navigate(activityPath(activeProject.id, nextActivityId))
            }
            onOpenTodo={handleOpenTodo}
            onArchiveProject={(isArchived) =>
              archiveMutation.mutate({ projectId: activeProject.id, isArchived })
            }
            onOpenDocument={(document) =>
              document.health === "missing"
                ? pushToast({
                    tone: "info",
                    title: "文件需要重新定位",
                    detail: document.sourceActivityTitle
                      ? `请先进入 ${document.sourceActivityTitle} 处理失效文件`
                      : "请在活动页重新定位该文件",
                  })
                : revealPath(document.managedPath)
            }
          />
        ) : showActivity && activeProject ? (
          <ActivityPage
            project={activeProject}
            activity={currentActivity ? { ...currentActivity, isExpanded: true } : null}
            loading={activitiesQuery.isLoading}
            focusId={focusId}
            busyAi={aiGenerateMutation.isPending || aiAcceptMutation.isPending}
            onBack={() => navigate(projectPath(activeProject.id))}
            onUpdateMeta={(input) => activityMetaMutation.mutate(input)}
            onAppendQuickNote={(input) => quickNoteMutation.mutate(input)}
            onSaveMinutes={(input) => minutesMutation.mutate(input)}
            onCreateConclusion={(input) => conclusionMutation.mutate(input)}
            onCreateTodo={(input) => todoMutation.mutate(input)}
            onChangeTodoStatus={(todoId, status) =>
              todoStatusMutation.mutate({ todoId, status })
            }
            onOpenTodo={handleOpenTodo}
            onImportDocument={(input) => documentImportMutation.mutate(input)}
            onToggleDocumentStar={(document) =>
              documentMetaMutation.mutate({
                documentId: document.id,
                isStarred: !document.isStarred,
              })
            }
            onChangeDocumentRole={(documentId, role) =>
              documentMetaMutation.mutate({ documentId, role })
            }
            onToggleDocumentPromotion={(document) =>
              documentMetaMutation.mutate({
                documentId: document.id,
                promotedToProject: !document.promotedToProject,
              })
            }
            onRelocateDocument={async (document) => {
              const path = await pickFile();
              if (!path) {
                return;
              }
              documentRelocateMutation.mutate({
                documentId: document.id,
                newSourcePath: path,
              });
            }}
            onGenerateSuggestions={(nextActivityId, noteId) => {
              aiGenerateMutation.mutate({
                projectId: activeProject.id,
                activityId: nextActivityId,
                noteId,
              });
            }}
            onAcceptSuggestion={(suggestion) =>
              aiAcceptMutation.mutate({ suggestionId: suggestion.id })
            }
          />
        ) : (
          <section className="workspace-loading">
            <LoaderCircle className="spin" size={18} />
            正在加载项目工作区...
          </section>
        )}
      </main>

      {activeTodo ? (
        <TodoDetailRail
          todo={activeTodo}
          updating={todoStatusMutation.isPending || todoProgressMutation.isPending}
          onClose={() => setActiveTodoId(null)}
          onChangeStatus={(status) =>
            todoStatusMutation.mutate({ todoId: activeTodo.id, status })
          }
          onAddProgress={(content, statusSnapshot) =>
            todoProgressMutation.mutate({
              todoId: activeTodo.id,
              content,
              statusSnapshot,
            })
          }
        />
      ) : null}

      {createProjectOpen ? (
        <CreateProjectModal
          standalone={showEmptyWorkspace}
          isPending={createProjectMutation.isPending}
          onClose={() => setCreateProjectOpen(false)}
          onSubmit={(input) => createProjectMutation.mutate(input)}
        />
      ) : null}
    </div>
  );
}

function WorkspaceTopBar({
  projects,
  activeProjectId,
  archivedProjects,
  searchInput,
  onSearchInput,
  searchGroups,
  searching,
  archiveOpen,
  onToggleArchive,
  onCloseArchive,
  onOpenProject,
  onRestoreProject,
  onCreateProject,
  onSearchSelect,
}: {
  projects: ProjectListItem[];
  activeProjectId: number | null;
  archivedProjects: ProjectListItem[];
  searchInput: string;
  onSearchInput: (value: string) => void;
  searchGroups: Array<readonly [string, WorkspaceSearchResult[]]>;
  searching: boolean;
  archiveOpen: boolean;
  onToggleArchive: () => void;
  onCloseArchive: () => void;
  onOpenProject: (projectId: number) => void;
  onRestoreProject: (projectId: number) => void;
  onCreateProject: () => void;
  onSearchSelect: (result: WorkspaceSearchResult) => void;
}) {
  return (
    <header className="workspace-topbar">
      <div className="workspace-topbar__left">
        <div className="workspace-brand">
          <div className="workspace-brand__mark">
            <FolderKanban size={14} />
          </div>
          <span>Architectural Ledger</span>
        </div>
        <div className="workspace-tabs" role="tablist" aria-label="Projects">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={
                project.id === activeProjectId
                  ? "workspace-tab is-active"
                  : "workspace-tab"
              }
              onClick={() => onOpenProject(project.id)}
            >
              <span className="workspace-tab__label">
                <span>{project.name}</span>
              </span>
            </button>
          ))}
          <button type="button" className="workspace-tab workspace-tab--create" onClick={onCreateProject}>
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="workspace-topbar__right">
        <div className="workspace-search">
          <Search size={16} />
          <input
            value={searchInput}
            onChange={(event) => onSearchInput(event.target.value)}
            placeholder="Search..."
          />
          {searchInput.trim() ? (
            <div className="workspace-search__panel">
              {searching ? (
                <div className="search-loading">
                  <LoaderCircle className="spin" size={14} />
                  搜索中...
                </div>
              ) : searchGroups.length > 0 ? (
                searchGroups.map(([group, results]) => (
                  <div key={group} className="search-group">
                    <p>{group}</p>
                    {results.map((result) => (
                      <button
                        key={`${result.kind}-${result.id}`}
                        type="button"
                        className="search-result"
                        onClick={() => onSearchSelect(result)}
                      >
                        <strong>{result.title || "Untitled"}</strong>
                        <span>{result.subtitle || result.matchedText}</span>
                      </button>
                    ))}
                  </div>
                ))
              ) : (
                <div className="search-empty">没有匹配结果</div>
              )}
            </div>
          ) : null}
        </div>

        <div className="workspace-utilities">
          <div className="workspace-popover">
            <button type="button" className="utility-icon" onClick={onToggleArchive}>
              <Archive size={16} />
            </button>
            {archiveOpen ? (
              <div className="archive-panel">
                <div className="archive-panel__head">
                  <strong>Archived Projects</strong>
                  <button type="button" onClick={onCloseArchive}>
                    关闭
                  </button>
                </div>
                {archivedProjects.length > 0 ? (
                  archivedProjects.map((project) => (
                    <div key={project.id} className="archive-row">
                      <button type="button" onClick={() => onOpenProject(project.id)}>
                        {project.name}
                      </button>
                      <button type="button" onClick={() => onRestoreProject(project.id)}>
                        恢复
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="archive-empty">暂无归档项目</div>
                )}
              </div>
            ) : null}
          </div>
          <button type="button" className="utility-icon">
            <CircleHelp size={16} />
          </button>
          <button type="button" className="utility-icon">
            <AlertCircle size={16} />
          </button>
          <button type="button" className="utility-icon">
            <Settings2 size={16} />
          </button>
          <button type="button" className="utility-avatar">
            <CircleUser size={18} />
          </button>
        </div>
      </div>
    </header>
  );
}

function ProjectOverviewPage({
  project,
  overview,
  loading,
  createActivityOpen,
  projectMenuOpen,
  focusId,
  onToggleProjectMenu,
  onCloseProjectMenu,
  onCreateActivityToggle,
  onCreateActivity,
  onSaveSummary,
  onImportProjectDocument,
  onUpdateConclusion,
  onCreateProjectTodo,
  onOpenActivity,
  onOpenTodo,
  onArchiveProject,
  onOpenDocument,
}: {
  project: ProjectListItem;
  overview: ProjectOverviewData;
  loading: boolean;
  createActivityOpen: boolean;
  projectMenuOpen: boolean;
  focusId: string | null;
  onToggleProjectMenu: () => void;
  onCloseProjectMenu: () => void;
  onCreateActivityToggle: (open: boolean) => void;
  onCreateActivity: (input: ActivityCreateInput) => void;
  onSaveSummary: (input: { projectId: number; summary: string; status?: string }) => void;
  onImportProjectDocument: () => void;
  onUpdateConclusion: (
    conclusionId: number,
    content: string,
    promotedToProject: boolean,
  ) => void;
  onCreateProjectTodo: (payload: {
    title: string;
    description?: string;
    priority: "low" | "medium" | "high";
    dueDate?: string;
  }) => void;
  onOpenActivity: (activityId: number) => void;
  onOpenTodo: (todoId: number | null) => void;
  onArchiveProject: (isArchived: boolean) => void;
  onOpenDocument: (document: DocumentRecord) => void | Promise<void>;
}) {
  useFocusTarget(focusId, [overview]);
  const activityMetaById = useMemo(
    () => new Map(overview.activityFeed.map((activity) => [activity.id, activity])),
    [overview.activityFeed],
  );

  return (
    <section className="overview-shell project-overview-shell">
      <div className="overview-columns">
        <aside className="overview-column overview-column--feed">
          <div className="overview-panel overview-panel--feed project-rail">
            <div className="project-rail__head">
              <div className="project-rail__headline">
                <strong>{project.name}</strong>
                <span>ACTIVE SESSION</span>
              </div>
              <button
                type="button"
                className="overview-primary-action overview-primary-action--rail"
                onClick={() => onCreateActivityToggle(!createActivityOpen)}
              >
                <span>New Entry</span>
              </button>
            </div>

            {createActivityOpen ? (
              <div className="project-rail__composer">
                <CreateActivityPanel
                  projectId={project.id}
                  isPending={loading}
                  onSubmit={onCreateActivity}
                />
              </div>
            ) : null}

            <div className="activity-feed">
              {overview.activityFeed.length > 0 ? (
                overview.activityFeed.map((activity) => (
                  <button
                    key={activity.id}
                    id={`activity-${activity.id}`}
                    type="button"
                    className="activity-feed__item"
                    onClick={() => onOpenActivity(activity.id)}
                  >
                    <div className="activity-feed__statusline">
                      <span
                        className={
                          activity.reviewStatus === "organized"
                            ? "review-pill is-organized"
                            : "review-pill is-review"
                        }
                      >
                        {activity.reviewStatus === "organized"
                          ? "ORGANIZED"
                          : "NEEDS REVIEW"}
                      </span>
                      <span className="activity-feed__time">
                        {formatRelativeSessionTime(activity.activityTime)}
                      </span>
                    </div>
                    <p className="activity-feed__summary">
                      {activity.title || "Untitled Activity"}
                    </p>
                    <div className="activity-feed__taxonomy">
                      <span>{categoryLabel(activity.category)}</span>
                      <span>•</span>
                      <span>{activity.documentCount} files</span>
                      <span>•</span>
                      <span>
                        {activity.completedTodoCount}/{activity.totalTodoCount} todos
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <EmptyState text="当前项目还没有 activity。先创建一条开始记录。" compact />
              )}
            </div>

            <div className="project-rail__footer">
              <button
                type="button"
                className="project-rail__footer-link"
                onClick={() => onArchiveProject(!project.isArchived)}
              >
                <Archive size={15} />
                {project.isArchived ? "Restore Project" : "Archive"}
              </button>
              <button type="button" className="project-rail__footer-link">
                <CircleHelp size={15} />
                Help
              </button>
            </div>
          </div>
        </aside>

        <section className="overview-column overview-column--main">
          <div className="overview-panel overview-panel--main project-main">
            <ProjectHeaderSection
              project={project}
              projectMenuOpen={projectMenuOpen}
              onToggleProjectMenu={onToggleProjectMenu}
              onCloseProjectMenu={onCloseProjectMenu}
              onSaveSummary={onSaveSummary}
              onArchiveProject={onArchiveProject}
            />

            <section className="overview-section overview-section--documents">
              <div className="overview-section__head">
                <SectionEyebrow
                  icon={<FileText size={14} />}
                  label="KEY DOCUMENTS"
                />
                <button
                  type="button"
                  className="overview-section__link"
                  onClick={() => revealPath(project.rootPath)}
                >
                  VIEW ALL FILES
                </button>
              </div>
              <div className="document-grid">
                {overview.keyDocuments.map((document) => (
                  <button
                    key={document.id}
                    id={`document-${document.id}`}
                    type="button"
                    className={
                      document.health === "missing"
                        ? "document-tile is-missing"
                        : "document-tile"
                    }
                    onClick={() => onOpenDocument(document)}
                  >
                    <div className="document-tile__icon">
                      <FileText size={15} />
                    </div>
                    <div className="document-tile__body">
                      <strong>{document.name}</strong>
                      <span>
                        {document.health === "missing"
                          ? "文件失效"
                          : formatDocumentMeta(document)}
                      </span>
                    </div>
                  </button>
                ))}
                <button
                  type="button"
                  className="document-tile document-tile--add"
                  onClick={onImportProjectDocument}
                >
                  <Plus size={15} />
                  <span>Add File</span>
                </button>
              </div>
            </section>

            <section className="overview-section overview-section--timeline">
              <div className="conclusion-groups">
                {overview.conclusionGroups.length > 0 ? (
                  overview.conclusionGroups.map((group, index) => (
                    <ConclusionGroupSection
                      key={group.activityId ?? -1}
                      group={group}
                      activity={group.activityId ? activityMetaById.get(group.activityId) ?? null : null}
                      index={index}
                      onSave={onUpdateConclusion}
                    />
                  ))
                ) : (
                  <EmptyState text="还没有结论。活动中的结论会自动上浮到这里。" compact />
                )}
              </div>
            </section>
          </div>
        </section>

        <aside className="overview-column overview-column--tasks">
          <TasksPanel
            unfinishedTodos={overview.unfinishedTodos}
            finishedTodos={overview.finishedTodos}
            onCreateTodo={onCreateProjectTodo}
            onOpenTodo={onOpenTodo}
          />
        </aside>
      </div>
    </section>
  );
}

function ProjectHeaderSection({
  project,
  projectMenuOpen,
  onToggleProjectMenu,
  onCloseProjectMenu,
  onSaveSummary,
  onArchiveProject,
}: {
  project: ProjectListItem;
  projectMenuOpen: boolean;
  onToggleProjectMenu: () => void;
  onCloseProjectMenu: () => void;
  onSaveSummary: (input: { projectId: number; summary: string; status?: string }) => void;
  onArchiveProject: (isArchived: boolean) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(project.summary);

  useEffect(() => {
    setSummaryDraft(project.summary);
    setIsEditing(false);
  }, [project.summary, project.id]);

  return (
    <section className="project-header">
      <div className="project-header__copy">
        <div className="project-title-row">
          <h1>{project.name}</h1>
          {project.isArchived ? <span className="archive-badge">ARCHIVED</span> : null}
        </div>
        {isEditing ? (
          <div className="summary-editor">
            <textarea
              value={summaryDraft}
              onChange={(event) => setSummaryDraft(event.target.value)}
              rows={3}
            />
            <div className="summary-editor__actions">
              <button
                type="button"
                className="summary-save"
                onClick={() => {
                  onSaveSummary({
                    projectId: project.id,
                    summary: summaryDraft,
                    status: project.status,
                  });
                  setIsEditing(false);
                }}
              >
                保存
              </button>
              <button
                type="button"
                className="summary-cancel"
                onClick={() => {
                  setSummaryDraft(project.summary);
                  setIsEditing(false);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="summary-preview"
            onClick={() => setIsEditing(true)}
          >
            {project.summary || "点击添加项目简介，说明当前阶段、目标和关键约束。"}
          </button>
        )}
      </div>

      <div className="project-header__actions">
        <button type="button" className="icon-square">
          <Share2 size={16} />
        </button>
        <div className="project-menu">
          <button type="button" className="icon-square" onClick={onToggleProjectMenu}>
            <MoreHorizontal size={16} />
          </button>
          {projectMenuOpen ? (
            <div className="project-menu__panel">
              <button
                type="button"
                onClick={() => {
                  onArchiveProject(!project.isArchived);
                  onCloseProjectMenu();
                }}
              >
                {project.isArchived ? "恢复项目" : "归档项目"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ConclusionGroupSection({
  group,
  activity,
  index,
  onSave,
}: {
  group: ConclusionGroup;
  activity: ActivityDigest | null;
  index: number;
  onSave: (conclusionId: number, content: string, promotedToProject: boolean) => void;
}) {
  const tone =
    activity?.reviewStatus === "needs_review" ? "critical" : index % 2 === 0 ? "secondary" : "tertiary";

  return (
    <article className={`timeline-entry timeline-entry--${tone}`}>
      <div className="timeline-entry__rail" />
      <div className="timeline-entry__content">
        <div className="timeline-entry__head">
          <div>
            <span className="timeline-entry__eyebrow">
              {activity ? categoryLabel(activity.category) : "PROJECT"}
            </span>
            <h3>{group.activityTitle}</h3>
          </div>
          <span className="timeline-entry__time">
            {activity ? formatOverviewDate(activity.activityTime) : ""}
          </span>
        </div>
        <div className="conclusion-group__list">
        {group.conclusions.map((conclusion) => (
          <InlineConclusionEditor
            key={conclusion.id}
            conclusion={conclusion}
            onSave={onSave}
          />
        ))}
        </div>
      </div>
    </article>
  );
}

function InlineConclusionEditor({
  conclusion,
  onSave,
}: {
  conclusion: ConclusionRecord;
  onSave: (conclusionId: number, content: string, promotedToProject: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conclusion.content);
  const preview = useMemo(
    () => buildConclusionPreview(conclusion.content),
    [conclusion.content],
  );

  useEffect(() => {
    setDraft(conclusion.content);
    setEditing(false);
  }, [conclusion.content, conclusion.id]);

  return (
    <article id={`conclusion-${conclusion.id}`} className="conclusion-card">
      <div className="conclusion-card__body">
        <div className="conclusion-card__head">
          {preview.heading ? <strong>{preview.heading}</strong> : <span />}
          <button type="button" onClick={() => setEditing((value) => !value)}>
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>
        {editing ? (
          <div className="conclusion-card__editor">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} />
            <div className="conclusion-card__actions">
              <button
                type="button"
                onClick={() => {
                  onSave(conclusion.id, draft, conclusion.promotedToProject);
                  setEditing(false);
                }}
              >
                保存修改
              </button>
            </div>
          </div>
        ) : (
          <p>{preview.body}</p>
        )}
      </div>
    </article>
  );
}

function TasksPanel({
  unfinishedTodos,
  finishedTodos,
  onCreateTodo,
  onOpenTodo,
}: {
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
  onCreateTodo: (payload: {
    title: string;
    description?: string;
    priority: "low" | "medium" | "high";
    dueDate?: string;
  }) => void;
  onOpenTodo: (todoId: number | null) => void;
}) {
  const [tab, setTab] = useState<"unfinished" | "finished">("unfinished");
  const [isComposing, setIsComposing] = useState(false);

  const todos = tab === "unfinished" ? unfinishedTodos : finishedTodos;
  const totalTodos = unfinishedTodos.length + finishedTodos.length;
  const velocity = totalTodos === 0 ? 0 : Math.round((finishedTodos.length / totalTodos) * 100);
  const finishedPreview = finishedTodos[0] ?? null;

  return (
    <div className="overview-panel overview-panel--tasks tasks-rail">
      <div className="tasks-head">
        <h2>TASKS</h2>
        <button
          type="button"
          className="task-add-button"
          onClick={() => setIsComposing((value) => !value)}
        >
          <Plus size={14} />
          ADD TASK
        </button>
      </div>

      {isComposing ? (
        <ProjectTodoComposer
          onSubmit={(payload) => {
            onCreateTodo(payload);
            setIsComposing(false);
          }}
        />
      ) : null}

      <div className="tasks-tabs">
        <button
          type="button"
          className={tab === "unfinished" ? "tasks-tab is-active" : "tasks-tab"}
          onClick={() => setTab("unfinished")}
        >
          UNFINISHED TODOS
        </button>
        <button
          type="button"
          className={tab === "finished" ? "tasks-tab is-active" : "tasks-tab"}
          onClick={() => setTab("finished")}
        >
          FINISHED TODOS
        </button>
      </div>

      <div className="tasks-list">
        {todos.length > 0 ? (
          todos.map((todo) => (
            <button
              key={todo.id}
              id={`todo-${todo.id}`}
              type="button"
              className={`task-card ${taskTone(todo)}`}
              onClick={() => onOpenTodo(todo.id)}
            >
              <div className="task-card__body">
                <div className="task-card__head">
                  <strong>{todo.title}</strong>
                  <span className={`task-checkbox is-${todo.status}`} aria-hidden="true" />
                </div>
                <p>{latestTodoSummary(todo)}</p>
                <div className="task-card__meta">
                  <span>{formatTaskDate(todo)}</span>
                  <span>{todo.sourceActivityTitle || "Project"}</span>
                </div>
                {todo.sourceActivityTitle ? <span className="task-origin">Origin: {todo.sourceActivityTitle}</span> : null}
              </div>
            </button>
          ))
        ) : (
          <EmptyState text="当前分组还没有任务。" compact />
        )}
      </div>

      {tab === "unfinished" && finishedPreview ? (
        <div className="tasks-finished-preview">
          <strong>{finishedPreview.title}</strong>
          <span>Done {formatTaskDate(finishedPreview)}</span>
        </div>
      ) : null}

      <div className="tasks-velocity">
        <div className="tasks-velocity__icon">
          <Target size={16} />
        </div>
        <div className="tasks-velocity__body">
          <strong>Project Velocity</strong>
          <div className="tasks-velocity__meter">
            <div style={{ width: `${velocity}%` }} />
          </div>
        </div>
        <span>{velocity}%</span>
      </div>
    </div>
  );
}

function ProjectTodoComposer({
  onSubmit,
}: {
  onSubmit: (payload: {
    title: string;
    description?: string;
    priority: "low" | "medium" | "high";
    dueDate?: string;
  }) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [dueDate, setDueDate] = useState("");

  return (
    <div className="project-task-composer">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="输入项目级任务标题"
      />
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        rows={3}
        placeholder="补充当前状态、责任人或依赖项"
      />
      <div className="project-task-composer__row">
        <select value={priority} onChange={(event) => setPriority(event.target.value as "low" | "medium" | "high")}>
          {TODO_PRIORITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            if (!title.trim()) {
              return;
            }
            onSubmit({
              title,
              description: description || undefined,
              priority,
              dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
            });
            setTitle("");
            setDescription("");
            setPriority("medium");
            setDueDate("");
          }}
        >
          保存
        </button>
      </div>
    </div>
  );
}

function ActivityPage({
  project,
  activity,
  loading,
  focusId,
  busyAi,
  onBack,
  onUpdateMeta,
  onAppendQuickNote,
  onSaveMinutes,
  onCreateConclusion,
  onCreateTodo,
  onChangeTodoStatus,
  onOpenTodo,
  onImportDocument,
  onToggleDocumentStar,
  onChangeDocumentRole,
  onToggleDocumentPromotion,
  onRelocateDocument,
  onGenerateSuggestions,
  onAcceptSuggestion,
}: {
  project: ProjectListItem;
  activity: ActivityCardData | null;
  loading: boolean;
  focusId: string | null;
  busyAi: boolean;
  onBack: () => void;
  onUpdateMeta: (input: ActivityUpdateMetaInput) => void;
  onAppendQuickNote: (input: {
    projectId: number;
    activityId: number;
    title?: string;
    content: string;
  }) => void;
  onSaveMinutes: (input: {
    projectId: number;
    activityId: number;
    noteId?: number;
    title?: string;
    markdown: string;
    html: string;
  }) => void;
  onCreateConclusion: (input: ConclusionCreateInput) => void;
  onCreateTodo: (input: {
    projectId: number;
    activityId?: number;
    title: string;
    description?: string;
    priority?: "low" | "medium" | "high";
    dueDate?: string;
  }) => void;
  onChangeTodoStatus: (todoId: number, status: TodoRecord["status"]) => void;
  onOpenTodo: (todoId: number | null) => void;
  onImportDocument: (input: {
    projectId: number;
    activityId?: number;
    sourcePath: string;
    role: DocumentRecord["role"];
    isStarred: boolean;
    promotedToProject?: boolean;
  }) => void;
  onToggleDocumentStar: (document: DocumentRecord) => void;
  onChangeDocumentRole: (documentId: number, role: DocumentRecord["role"]) => void;
  onToggleDocumentPromotion: (document: DocumentRecord) => void;
  onRelocateDocument: (document: DocumentRecord) => void;
  onGenerateSuggestions: (activityId: number, noteId?: number) => void;
  onAcceptSuggestion: (suggestion: AiSuggestionRecord) => void;
}) {
  useFocusTarget(focusId, [activity]);

  return (
    <section className="activity-route">
      <div className="activity-route__head">
        <button type="button" className="activity-route__back" onClick={onBack}>
          <ArrowLeft size={15} />
          {project.name}
        </button>
        <div>
          <p>Activity Page</p>
          <h1>{activity?.title || "Loading activity..."}</h1>
        </div>
      </div>

      {loading ? (
        <div className="workspace-loading">
          <LoaderCircle className="spin" size={18} />
          正在加载 activity...
        </div>
      ) : activity ? (
        <div className="activity-route__body">
          <ActivityCard
            activity={activity}
            busyAi={busyAi}
            lockExpanded
            onUpdateMeta={onUpdateMeta}
            onAppendQuickNote={onAppendQuickNote}
            onSaveMinutes={onSaveMinutes}
            onCreateConclusion={onCreateConclusion}
            onCreateTodo={onCreateTodo}
            onChangeTodoStatus={onChangeTodoStatus}
            onOpenTodo={onOpenTodo}
            onImportDocument={onImportDocument}
            onToggleDocumentStar={onToggleDocumentStar}
            onChangeDocumentRole={onChangeDocumentRole}
            onToggleDocumentPromotion={onToggleDocumentPromotion}
            onRelocateDocument={onRelocateDocument}
            onGenerateSuggestions={onGenerateSuggestions}
            onAcceptSuggestion={onAcceptSuggestion}
          />
        </div>
      ) : (
        <EmptyState text="没有找到这个 activity。" />
      )}
    </section>
  );
}

function CreateProjectModal({
  standalone,
  isPending,
  onClose,
  onSubmit,
}: {
  standalone: boolean;
  isPending: boolean;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    summary?: string;
    status?: string;
    workspaceRoot: string;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState("active");
  const [workspaceRoot, setWorkspaceRoot] = useState("");

  return (
    <div className={standalone ? "project-modal project-modal--standalone" : "project-modal"}>
      <div className="project-modal__panel">
        {!standalone ? (
          <button type="button" className="project-modal__close" onClick={onClose}>
            关闭
          </button>
        ) : null}
        <div className="project-modal__hero">
          <div className="project-modal__icon">
            <FolderInput size={28} />
          </div>
          <h2>开始使用</h2>
          <p>创建您的第一个项目，开始记录和管理项目信息。</p>
        </div>

        <form
          className="project-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              name,
              summary,
              status,
              workspaceRoot,
            });
          }}
        >
          <label className="field">
            <span>项目名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：华东结算平台迁移"
              required
            />
          </label>

          <label className="field">
            <span>项目状态</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {PROJECT_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>项目简介</span>
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={4}
              placeholder="补充目标、阶段判断或当前问题。"
            />
          </label>

          <label className="field">
            <span>工作目录</span>
            <div className="compound-field">
              <input
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
                placeholder="/Users/you/Workspace"
                required
              />
              <button
                type="button"
                className="ghost-button"
                onClick={async () => {
                  const path = await pickDirectory();
                  if (path) {
                    setWorkspaceRoot(path);
                  }
                }}
              >
                <FolderOpen size={16} />
                选择目录
              </button>
            </div>
          </label>

          <button type="submit" className="primary-button" disabled={isPending}>
            {isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
            创建项目
          </button>
        </form>
      </div>
    </div>
  );
}

function EmptyWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="empty-workspace">
      <div className="empty-workspace__hero">
        <div className="empty-workspace__mark">
          <FolderKanban size={32} />
        </div>
        <h1>项目资料管理系统</h1>
        <p>围绕项目推进的结构化工作台</p>
        <span>从原始记录中沉淀关键结论和待办事项，让项目状态清晰可见。</span>
      </div>
      <button type="button" className="primary-button" onClick={onCreate}>
        <Plus size={16} />
        创建项目
      </button>
    </section>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ReturnType<typeof useAppStore.getState>["toasts"];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          <div>
            <strong>{toast.title}</strong>
            {toast.detail ? <p>{toast.detail}</p> : null}
          </div>
          <button type="button" onClick={() => onDismiss(toast.id)}>
            关闭
          </button>
        </div>
      ))}
    </div>
  );
}

function SectionEyebrow({ icon, label }: { icon?: ReactNode; label: string }) {
  return (
    <div className="section-eyebrow">
      {icon ? <span>{icon}</span> : null}
      <p>{label}</p>
    </div>
  );
}

function ActivityCard({
  activity,
  busyAi,
  lockExpanded = false,
  onUpdateMeta,
  onAppendQuickNote,
  onSaveMinutes,
  onCreateConclusion,
  onCreateTodo,
  onChangeTodoStatus,
  onOpenTodo,
  onImportDocument,
  onToggleDocumentStar,
  onChangeDocumentRole,
  onToggleDocumentPromotion,
  onRelocateDocument,
  onGenerateSuggestions,
  onAcceptSuggestion,
}: {
  activity: ActivityCardData;
  busyAi: boolean;
  lockExpanded?: boolean;
  onUpdateMeta: (input: ActivityUpdateMetaInput) => void;
  onAppendQuickNote: (input: {
    projectId: number;
    activityId: number;
    title?: string;
    content: string;
  }) => void;
  onSaveMinutes: (input: {
    projectId: number;
    activityId: number;
    noteId?: number;
    title?: string;
    markdown: string;
    html: string;
  }) => void;
  onCreateConclusion: (input: ConclusionCreateInput) => void;
  onCreateTodo: (input: {
    projectId: number;
    activityId?: number;
    title: string;
    description?: string;
    priority?: "low" | "medium" | "high";
    dueDate?: string;
  }) => void;
  onChangeTodoStatus: (todoId: number, status: TodoRecord["status"]) => void;
  onOpenTodo: (todoId: number | null) => void;
  onImportDocument: (input: {
    projectId: number;
    activityId?: number;
    sourcePath: string;
    role: DocumentRecord["role"];
    isStarred: boolean;
    promotedToProject?: boolean;
  }) => void;
  onToggleDocumentStar: (document: DocumentRecord) => void;
  onChangeDocumentRole: (documentId: number, role: DocumentRecord["role"]) => void;
  onToggleDocumentPromotion: (document: DocumentRecord) => void;
  onRelocateDocument: (document: DocumentRecord) => void;
  onGenerateSuggestions: (activityId: number, noteId?: number) => void;
  onAcceptSuggestion: (suggestion: AiSuggestionRecord) => void;
}) {
  const [quickNote, setQuickNote] = useState("");
  const [conclusionDraft, setConclusionDraft] = useState("");
  const [promoteConclusion, setPromoteConclusion] = useState(true);
  const [todoTitle, setTodoTitle] = useState("");
  const [todoDescription, setTodoDescription] = useState("");
  const [todoPriority, setTodoPriority] = useState<"low" | "medium" | "high">("medium");
  const [todoDueDate, setTodoDueDate] = useState("");
  const [documentRole, setDocumentRole] =
    useState<DocumentRecord["role"]>("reference_material");
  const [documentStarred, setDocumentStarred] = useState(false);
  const [documentPromoted, setDocumentPromoted] = useState(false);

  const minutes = activity.notes.find((note) => note.noteType === "meeting_minutes");
  const quickNotes = activity.notes.filter((note) => note.noteType === "quick_note");
  const pendingSuggestions = activity.aiSuggestions.filter(
    (suggestion) => suggestion.status === "pending",
  );

  return (
    <article className="activity-card activity-card--route">
      <button
        type="button"
        className="activity-header"
        onClick={() => {
          if (lockExpanded) {
            return;
          }
          onUpdateMeta({
            activityId: activity.id,
            isExpanded: !activity.isExpanded,
          });
        }}
      >
        <div className="activity-heading">
          <div className="activity-meta-line">
            <span className="meta-chip">{categoryLabel(activity.category)}</span>
            <span
              className={
                activity.organizeStatus === "organized"
                  ? "meta-status"
                  : "meta-status is-warning"
              }
            >
              {activity.organizeStatus === "organized" ? "已整理" : "待复核"}
            </span>
            {activity.digest.hasOpenTodos ? <span className="meta-status">有未完事项</span> : null}
          </div>
          <h4>{activity.title || "未命名活动"}</h4>
          <p>{formatDateTime(activity.activityTime)}</p>
        </div>
        <div className="activity-summary">
          <span>{activity.digest.noteCount} Note</span>
          <span>{activity.digest.conclusionCount} Conclusion</span>
          <span>{activity.digest.todoCount} Todo</span>
          <span>{activity.digest.documentCount} Document</span>
        </div>
      </button>

      <div className="activity-body">
        <div className="activity-body-head">
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              onUpdateMeta({
                activityId: activity.id,
                isPinned: !activity.isPinned,
              })
            }
          >
            {activity.isPinned ? <PinOff size={16} /> : <Pin size={16} />}
            {activity.isPinned ? "取消固定" : "固定展开"}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              onUpdateMeta({
                activityId: activity.id,
                organizeStatus:
                  activity.organizeStatus === "organized"
                    ? "needs_review"
                    : "organized",
              })
            }
          >
            {activity.organizeStatus === "organized" ? (
              <CircleDashed size={16} />
            ) : (
              <CheckCircle2 size={16} />
            )}
            {activity.organizeStatus === "organized" ? "标记待复核" : "标记已整理"}
          </button>
        </div>

        <div className="activity-sections">
          <section className="activity-panel notes-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">Raw notes</p>
                <h5>原始记录</h5>
              </div>
            </div>

            <form
              className="quick-note-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!quickNote.trim()) {
                  return;
                }
                onAppendQuickNote({
                  projectId: activity.projectId,
                  activityId: activity.id,
                  content: quickNote,
                });
                setQuickNote("");
              }}
            >
              <textarea
                value={quickNote}
                onChange={(event) => setQuickNote(event.target.value)}
                rows={4}
                placeholder="想到就写。先留下原始信息，再决定是否提炼为结论或待办。"
              />
              <button type="submit" className="primary-button">
                <Plus size={16} />
                追加 quick note
              </button>
            </form>

            <div className="note-stream">
              {quickNotes.length > 0 ? (
                quickNotes.map((note) => (
                  <article key={note.id} className="note-card quick-note-card">
                    <header>
                      <span>Quick note</span>
                      <time>{formatDateTime(note.createdAt)}</time>
                    </header>
                    <p>{note.contentMarkdown}</p>
                  </article>
                ))
              ) : (
                <EmptyState text="还没有 quick note。先把讨论原文记下来。" compact />
              )}
            </div>

            <div className="minutes-section">
              <div className="section-title compact">
                <div>
                  <p className="eyebrow">Meeting minutes</p>
                  <h5>正式纪要</h5>
                </div>
              </div>
              <RichTextEditor
                initialHtml={minutes?.contentHtml}
                onSave={(markdown, html) =>
                  onSaveMinutes({
                    projectId: activity.projectId,
                    activityId: activity.id,
                    noteId: minutes?.id,
                    title: minutes?.title ?? "会议纪要",
                    markdown,
                    html,
                  })
                }
              />
            </div>
          </section>

          <section className="activity-panel results-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">Structured results</p>
                <h5>沉淀结果</h5>
              </div>
            </div>

            <InlineComposer
              title="新增结论"
              description="记录已经确认的判断、共识或决定。"
              actionLabel="保存结论"
              value={conclusionDraft}
              onChange={setConclusionDraft}
              promote={promoteConclusion}
              onTogglePromote={setPromoteConclusion}
              onSubmit={() => {
                if (!conclusionDraft.trim()) {
                  return;
                }
                onCreateConclusion({
                  projectId: activity.projectId,
                  activityId: activity.id,
                  content: conclusionDraft,
                  promotedToProject: promoteConclusion,
                });
                setConclusionDraft("");
              }}
            />

            <TodoComposer
              title="新增待办"
              description="记录需要被推进的动作与责任事项。"
              submitLabel="保存待办"
              titleValue={todoTitle}
              setTitleValue={setTodoTitle}
              descriptionValue={todoDescription}
              setDescriptionValue={setTodoDescription}
              priorityValue={todoPriority}
              setPriorityValue={setTodoPriority}
              dueDateValue={todoDueDate}
              setDueDateValue={setTodoDueDate}
              onSubmit={(payload) => {
                onCreateTodo({
                  projectId: activity.projectId,
                  activityId: activity.id,
                  title: payload.title,
                  description: payload.description,
                  priority: payload.priority,
                  dueDate: payload.dueDate,
                });
                setTodoTitle("");
                setTodoDescription("");
                setTodoPriority("medium");
                setTodoDueDate("");
              }}
            />

            <div className="structured-grid">
              <div>
                <div className="section-title compact">
                  <div>
                    <p className="eyebrow">Conclusions</p>
                    <h5>结论列表</h5>
                  </div>
                </div>
                {activity.conclusions.length > 0 ? (
                  <div className="stack-list">
                    {activity.conclusions.map((item) => (
                      <article key={item.id} id={`conclusion-${item.id}`} className="result-card">
                        <div>
                          <strong>{item.content}</strong>
                          <span>
                            {item.promotedToProject ? "项目级可见" : "活动内结论"} ·{" "}
                            {formatDateTime(item.updatedAt)}
                          </span>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState text="还没有结论。" compact />
                )}
              </div>

              <div>
                <div className="section-title compact">
                  <div>
                    <p className="eyebrow">Todos</p>
                    <h5>待办列表</h5>
                  </div>
                </div>
                {activity.todos.length > 0 ? (
                  <div className="stack-list">
                    {activity.todos.map((todo) => (
                      <article key={todo.id} id={`todo-${todo.id}`} className="result-card todo-card">
                        <button type="button" className="todo-main" onClick={() => onOpenTodo(todo.id)}>
                          <div>
                            <strong>{todo.title}</strong>
                            <span>
                              {todoStatusLabel(todo.status)} · {priorityLabel(todo.priority)}
                            </span>
                          </div>
                          <ArrowUpRight size={16} />
                        </button>
                        <div className="todo-actions-inline">
                          {TODO_STATUS_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={
                                option.value === todo.status
                                  ? "status-toggle is-active"
                                  : "status-toggle"
                              }
                              onClick={() =>
                                onChangeTodoStatus(todo.id, option.value as TodoRecord["status"])
                              }
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState text="还没有待办。" compact />
                )}
              </div>
            </div>
          </section>

          <section className="activity-panel documents-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">Documents</p>
                <h5>文件材料</h5>
              </div>
            </div>

            <DocumentImportControls
              role={documentRole}
              setRole={setDocumentRole}
              isStarred={documentStarred}
              setIsStarred={setDocumentStarred}
              promotedToProject={documentPromoted}
              setPromotedToProject={setDocumentPromoted}
              onImport={async () => {
                const path = await pickFile();
                if (!path) {
                  return;
                }
                onImportDocument({
                  projectId: activity.projectId,
                  activityId: activity.id,
                  sourcePath: path,
                  role: documentRole,
                  isStarred: documentStarred,
                  promotedToProject: documentPromoted,
                });
              }}
            />

            {activity.documents.length > 0 ? (
              <div className="document-list">
                {activity.documents.map((document) => (
                  <article key={document.id} id={`document-${document.id}`} className="document-row">
                    <div>
                      <div className="document-head">
                        <strong>{document.name}</strong>
                        <span
                          className={
                            document.health === "missing"
                              ? "health-badge is-missing"
                              : "health-badge"
                          }
                        >
                          {document.health === "missing" ? "文件失效" : roleLabel(document.role)}
                        </span>
                      </div>
                      <p>{document.originalPath}</p>
                      <div className="document-submeta">
                        {document.promotedToProject ? "已上浮到 Project Overview" : "仅活动内可见"}
                      </div>
                    </div>
                    <div className="document-actions">
                      <select
                        value={document.role}
                        onChange={(event) =>
                          onChangeDocumentRole(
                            document.id,
                            event.target.value as DocumentRecord["role"],
                          )
                        }
                      >
                        {DOCUMENT_ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => onToggleDocumentPromotion(document)}
                      >
                        {document.promotedToProject ? "取消上浮" : "上浮到项目"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => onToggleDocumentStar(document)}
                      >
                        {document.isStarred ? <StarOff size={16} /> : <Star size={16} />}
                        {document.isStarred ? "取消标星" : "标星"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          document.health === "missing"
                            ? onRelocateDocument(document)
                            : revealPath(document.managedPath)
                        }
                      >
                        {document.health === "missing" ? (
                          <>
                            <AlertCircle size={16} />
                            重新定位
                          </>
                        ) : (
                          <>
                            <ArrowUpRight size={16} />
                            打开
                          </>
                        )}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState text="还没有关联文件。" compact />
            )}
          </section>

          <section className="activity-panel ai-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">AI suggestions</p>
                <h5>AI 辅助提炼</h5>
              </div>
              <button
                type="button"
                className="primary-button"
                disabled={busyAi}
                onClick={() => onGenerateSuggestions(activity.id)}
              >
                <Sparkles size={16} />
                生成建议
              </button>
            </div>

            {pendingSuggestions.length > 0 ? (
              <div className="stack-list">
                {pendingSuggestions.map((suggestion) => (
                  <article key={suggestion.id} className="suggestion-card">
                    <div className="suggestion-copy">
                      <span>{suggestionLabel(suggestion.suggestionType)}</span>
                      <strong>{suggestion.preview}</strong>
                    </div>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onAcceptSuggestion(suggestion)}
                    >
                      采纳
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                text="先生成 AI 候选项。采纳后才会进入正式数据。"
                compact
              />
            )}
          </section>
        </div>
      </div>
    </article>
  );
}

function CreateActivityPanel({
  projectId,
  isPending,
  onSubmit,
}: {
  projectId: number;
  isPending: boolean;
  onSubmit: (input: ActivityCreateInput) => void;
}) {
  const [category, setCategory] = useState("product");
  const [title, setTitle] = useState("");
  const [activityTime, setActivityTime] = useState(roundToHalfHourLocal());

  return (
    <form
      className="inline-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          projectId,
          category,
          title,
          activityTime: new Date(activityTime).toISOString(),
        });
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>分类</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {ACTIVITY_CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：法务确认 / 汇报准备 / 方案评审"
          />
        </label>
        <label className="field">
          <span>时间</span>
          <input
            type="datetime-local"
            value={activityTime}
            onChange={(event) => setActivityTime(event.target.value)}
          />
        </label>
      </div>
      <button type="submit" className="primary-button" disabled={isPending}>
        {isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
        创建并进入记录
      </button>
    </form>
  );
}

function InlineComposer({
  title,
  description,
  actionLabel,
  value,
  onChange,
  onSubmit,
  promote,
  onTogglePromote,
}: {
  title: string;
  description: string;
  actionLabel: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  promote?: boolean;
  onTogglePromote?: (value: boolean) => void;
}) {
  return (
    <div className="inline-panel compact-panel">
      <div className="section-title compact">
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        placeholder="输入结论内容..."
      />
      <div className="inline-actions">
        {onTogglePromote ? (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={promote}
              onChange={(event) => onTogglePromote(event.target.checked)}
            />
            提升到项目首页
          </label>
        ) : (
          <span className="muted-copy">保存后立即进入正式数据。</span>
        )}
        <button type="button" className="primary-button" onClick={onSubmit}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function TodoComposer({
  title,
  description,
  submitLabel,
  titleValue,
  setTitleValue,
  descriptionValue,
  setDescriptionValue,
  priorityValue,
  setPriorityValue,
  dueDateValue,
  setDueDateValue,
  onSubmit,
}: {
  title: string;
  description: string;
  submitLabel: string;
  titleValue: string;
  setTitleValue: (value: string) => void;
  descriptionValue: string;
  setDescriptionValue: (value: string) => void;
  priorityValue: "low" | "medium" | "high";
  setPriorityValue: (value: "low" | "medium" | "high") => void;
  dueDateValue: string;
  setDueDateValue: (value: string) => void;
  onSubmit: (payload: {
    title: string;
    description?: string;
    priority: "low" | "medium" | "high";
    dueDate?: string;
  }) => void;
}) {
  return (
    <div className="inline-panel compact-panel">
      <div className="section-title compact">
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>标题</span>
          <input
            value={titleValue}
            onChange={(event) => setTitleValue(event.target.value)}
            placeholder="例如：整理法务意见并确认修改项"
          />
        </label>
        <label className="field">
          <span>优先级</span>
          <select
            value={priorityValue}
            onChange={(event) => setPriorityValue(event.target.value as "low" | "medium" | "high")}
          >
            {TODO_PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>截止时间</span>
          <input
            type="datetime-local"
            value={dueDateValue}
            onChange={(event) => setDueDateValue(event.target.value)}
          />
        </label>
      </div>
      <label className="field">
        <span>描述</span>
        <textarea
          value={descriptionValue}
          onChange={(event) => setDescriptionValue(event.target.value)}
          rows={3}
          placeholder="补充责任人、依赖项或上下文。"
        />
      </label>
      <div className="inline-actions">
        <span className="muted-copy">待办创建后可在右侧详情面板持续更新进展。</span>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            if (!titleValue.trim()) {
              return;
            }
            onSubmit({
              title: titleValue,
              description: descriptionValue || undefined,
              priority: priorityValue,
              dueDate: dueDateValue ? new Date(dueDateValue).toISOString() : undefined,
            });
          }}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function DocumentImportControls({
  role,
  setRole,
  isStarred,
  setIsStarred,
  promotedToProject,
  setPromotedToProject,
  onImport,
}: {
  role: DocumentRecord["role"];
  setRole: (value: DocumentRecord["role"]) => void;
  isStarred: boolean;
  setIsStarred: (value: boolean) => void;
  promotedToProject: boolean;
  setPromotedToProject: (value: boolean) => void;
  onImport: () => void;
}) {
  return (
    <div className="document-import-box">
      <div className="form-grid">
        <label className="field">
          <span>文件角色</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as DocumentRecord["role"])}
          >
            {DOCUMENT_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={isStarred}
            onChange={(event) => setIsStarred(event.target.checked)}
          />
          导入后直接标星
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={promotedToProject}
            onChange={(event) => setPromotedToProject(event.target.checked)}
          />
          同时上浮到项目级
        </label>
      </div>
      <button type="button" className="primary-button" onClick={onImport}>
        <FilePlus2 size={16} />
        选择并导入文件
      </button>
    </div>
  );
}

function TodoDetailRail({
  todo,
  updating,
  onClose,
  onChangeStatus,
  onAddProgress,
}: {
  todo: TodoRecord;
  updating: boolean;
  onClose: () => void;
  onChangeStatus: (status: TodoRecord["status"]) => void;
  onAddProgress: (content: string, statusSnapshot: TodoRecord["status"]) => void;
}) {
  const [progress, setProgress] = useState("");
  const [statusSnapshot, setStatusSnapshot] = useState<TodoRecord["status"]>(todo.status);

  useEffect(() => {
    setStatusSnapshot(todo.status);
  }, [todo.status]);

  return (
    <aside className="detail-rail detail-rail--floating">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Todo detail</p>
          <h3>{todo.title}</h3>
          <p>{todo.description || "没有补充描述。"}</p>
        </div>
        <button type="button" className="ghost-button" onClick={onClose}>
          关闭
        </button>
      </div>

      <dl className="detail-meta">
        <div>
          <dt>状态</dt>
          <dd>{todoStatusLabel(todo.status)}</dd>
        </div>
        <div>
          <dt>优先级</dt>
          <dd>{priorityLabel(todo.priority)}</dd>
        </div>
        <div>
          <dt>来源活动</dt>
          <dd>{todo.sourceActivityTitle || "项目级待办"}</dd>
        </div>
        <div>
          <dt>截止时间</dt>
          <dd>{todo.dueDate ? formatDateTime(todo.dueDate) : "未设置"}</dd>
        </div>
      </dl>

      <div className="detail-section">
        <div className="section-title compact">
          <div>
            <p className="eyebrow">Status</p>
            <h4>快速切换</h4>
          </div>
        </div>
        <div className="status-grid">
          {TODO_STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                option.value === todo.status ? "status-toggle is-active" : "status-toggle"
              }
              onClick={() => onChangeStatus(option.value as TodoRecord["status"])}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <div className="section-title compact">
          <div>
            <p className="eyebrow">Progress</p>
            <h4>追加进展</h4>
          </div>
        </div>
        <textarea
          value={progress}
          onChange={(event) => setProgress(event.target.value)}
          rows={4}
          placeholder="例如：已和法务确认条款，待产品补充版本说明。"
        />
        <div className="inline-actions">
          <select
            value={statusSnapshot}
            onChange={(event) => setStatusSnapshot(event.target.value as TodoRecord["status"])}
          >
            {TODO_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary-button"
            disabled={updating}
            onClick={() => {
              if (!progress.trim()) {
                return;
              }
              onAddProgress(progress, statusSnapshot);
              setProgress("");
            }}
          >
            {updating ? <LoaderCircle className="spin" size={16} /> : "保存进展"}
          </button>
        </div>
      </div>

      <div className="detail-section">
        <div className="section-title compact">
          <div>
            <p className="eyebrow">Timeline</p>
            <h4>历史进展</h4>
          </div>
        </div>
        {todo.progresses.length > 0 ? (
          <div className="progress-list">
            {todo.progresses.map((item) => (
              <article key={item.id} className="progress-card">
                <strong>{item.content}</strong>
                <span>
                  {todoStatusLabel(item.statusSnapshot)} · {formatDateTime(item.createdAt)}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState text="还没有进展记录。" compact />
        )}
      </div>
    </aside>
  );
}

function EmptyState({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={compact ? "empty-state compact" : "empty-state"}>{text}</div>;
}

function useFocusTarget(focusId: string | null, deps: unknown[]) {
  useEffect(() => {
    if (!focusId) {
      return;
    }
    const element = document.getElementById(focusId);
    if (!element) {
      return;
    }
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    element.classList.add("is-focused");
    const timer = window.setTimeout(() => {
      element.classList.remove("is-focused");
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [focusId, ...deps]);
}

function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);

  return debounced;
}

function groupSearchResults(results: WorkspaceSearchResult[]) {
  const orderedKinds: Array<[string, WorkspaceSearchResult["kind"]]> = [
    ["Projects", "project"],
    ["Activities", "activity"],
    ["Tasks", "todo"],
    ["Conclusions", "conclusion"],
    ["Documents", "document"],
  ];

  return orderedKinds
    .map(([label, kind]) => [label, results.filter((result) => result.kind === kind)] as const)
    .filter((entry) => entry[1].length > 0);
}

function refreshProjectScope(queryClient: ReturnType<typeof useQueryClient>, projectId: number) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["projects", "all"] }),
    queryClient.invalidateQueries({ queryKey: ["overview", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["activities", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard", projectId] }),
  ]);
}

function projectPath(projectId: number, focus?: string) {
  return focus ? `/projects/${projectId}?focus=${encodeURIComponent(focus)}` : `/projects/${projectId}`;
}

function activityPath(projectId: number, activityId: number, focus?: string) {
  return focus
    ? `/projects/${projectId}/activities/${activityId}?focus=${encodeURIComponent(focus)}`
    : `/projects/${projectId}/activities/${activityId}`;
}

function parseRouteId(value?: string) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function categoryLabel(value: string) {
  return ACTIVITY_CATEGORY_OPTIONS.find((option) => option.value === value)?.label ?? value.toUpperCase();
}

function todoStatusLabel(value: string) {
  return TODO_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function priorityLabel(value: string) {
  return TODO_PRIORITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function roleLabel(value: string) {
  return DOCUMENT_ROLE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function suggestionLabel(type: string) {
  switch (type) {
    case "activity_title":
      return "标题建议";
    case "conclusion":
      return "结论建议";
    case "todo":
      return "待办建议";
    default:
      return type;
  }
}

function latestTodoSummary(todo: TodoRecord) {
  return todo.progresses[0]?.content || todo.description || "等待补充进展";
}

function taskTone(todo: TodoRecord) {
  if (todo.status === "blocked" || todo.priority === "high") {
    return "task-card--critical";
  }
  if (todo.status === "done" || todo.status === "cancelled") {
    return "task-card--complete";
  }
  return "task-card--active";
}

function buildConclusionPreview(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { heading: "", body: "" };
  }

  const sentenceMatch = normalized.match(/^(.{1,48}?)[。！？.!?]\s*(.+)$/u);
  if (sentenceMatch) {
    return {
      heading: sentenceMatch[1].trim(),
      body: sentenceMatch[2].trim(),
    };
  }

  const lineMatch = normalized.match(/^(.{1,48})[:：-]\s*(.+)$/u);
  if (lineMatch) {
    return {
      heading: lineMatch[1].trim(),
      body: lineMatch[2].trim(),
    };
  }

  return { heading: "", body: normalized };
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatFeedTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRelativeSessionTime(value: string) {
  const date = new Date(value);
  const delta = Date.now() - date.getTime();
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  if (hours < 48) {
    return "Yesterday";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatOverviewDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(value))
    .replace(",", " •");
}

function formatRelativeTime(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) {
    return `${Math.max(minutes, 1)}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatDocumentMeta(document: DocumentRecord) {
  const extension = document.name.includes(".")
    ? document.name.split(".").pop()?.toUpperCase()
    : null;
  const relative = formatRelativeSessionTime(document.updatedAt);
  return extension ? `${extension} • ${relative}` : relative;
}

function formatTaskDate(todo: TodoRecord) {
  const source = todo.dueDate || todo.updatedAt || todo.createdAt;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(source));
}

function roundToHalfHourLocal() {
  const now = new Date();
  const minutes = now.getMinutes();
  const rounded = minutes < 30 ? 30 : 60;
  now.setMinutes(rounded, 0, 0);
  if (rounded === 60) {
    now.setHours(now.getHours() + 1, 0, 0, 0);
  }
  return now.toISOString().slice(0, 16);
}
