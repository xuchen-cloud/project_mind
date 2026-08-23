import { useMemo, useState } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderKanban,
  NotebookText,
  Pencil,
  Trash2,
} from "lucide-react";

import type { TagColorKey, ProjectListItem } from "../../lib/types";
import {
  PROJECT_SIDEBAR_WIDTH_MAX_PX,
  PROJECT_SIDEBAR_WIDTH_MIN_PX,
  useUiStore,
} from "../../state/ui-store";
import {
  ActionContextMenu,
  Button,
  Dialog,
  IconButton,
  ResizeHandle,
  SearchField,
  SidebarFilters,
  SidebarTabs,
  StatusBadge,
  type ContextMenuAction,
} from "../../ui/components";
import { cn } from "../../ui/lib/cn";

const WORKSPACE_SIDEBAR_TABS = [
  { value: "projects", label: "项目" },
  { value: "records", label: "记录" },
] as const;

export interface WorkspaceOverviewSidebarRecordItem {
  id: number;
  title?: string | null;
  contentMarkdown: string;
  tags: Array<{ id: number; label: string; colorKey: TagColorKey }>;
  updatedAt: string;
}

interface WorkspaceOverviewSidebarProps {
  workspaceRootPath: string;
  projects: ProjectListItem[];
  archivedProjects: ProjectListItem[];
  records: WorkspaceOverviewSidebarRecordItem[];
  activeRecordId?: number | null;
  recordQuery: string;
  onRecordQueryChange: (value: string) => void;
  activeRecordTagId: number | null;
  onActiveRecordTagIdChange: (tagId: number | null) => void;
  onOpenOverview: () => void;
  onOpenProject: (projectId: number) => void;
  onPrefetchProject?: (projectId: number) => void;
  onOpenProjectInNewWindow: (projectId: number) => void;
  onCreateProject: () => void;
  createProjectPending?: boolean;
  onOpenArchivedProject: (projectId: number) => void;
  onRestoreArchivedProject: (projectId: number) => void;
  onRenameProject: (project: ProjectListItem, name: string) => Promise<unknown> | unknown;
  onArchiveProject: (projectId: number) => void;
  onDeleteProject: (project: ProjectListItem) => void;
  onOpenRecord: (recordId: number) => void;
  onFocusRecord?: (recordId: number) => void;
  onCreateRecord: () => void;
}

export function WorkspaceOverviewSidebar({
  workspaceRootPath,
  projects,
  archivedProjects,
  records,
  activeRecordId,
  recordQuery,
  onRecordQueryChange,
  activeRecordTagId,
  onActiveRecordTagIdChange,
  onOpenOverview,
  onOpenProject,
  onPrefetchProject,
  onOpenProjectInNewWindow,
  onCreateProject,
  createProjectPending = false,
  onOpenArchivedProject,
  onRestoreArchivedProject,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  onOpenRecord,
  onFocusRecord,
  onCreateRecord,
}: WorkspaceOverviewSidebarProps) {
  const {
    projectSidebarCollapsed,
    projectSidebarWidthPx,
    toggleProjectSidebarCollapsed,
    setProjectSidebarWidthPx,
    workspaceSidebarTab: activeTab,
    setWorkspaceSidebarTab: setActiveTab,
    workspaceProjectQuery: projectQuery,
    setWorkspaceProjectQuery: setProjectQuery,
  } = useUiStore();
  const [projectContextMenu, setProjectContextMenu] = useState<{
    projectId: number;
    x: number;
    y: number;
  } | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [deleteConfirmProject, setDeleteConfirmProject] = useState<ProjectListItem | null>(null);
  const normalizedProjectQuery = projectQuery.trim().toLowerCase();

  const filteredProjects = useMemo(
    () =>
      projects.filter((project) =>
        !normalizedProjectQuery || project.name.toLowerCase().includes(normalizedProjectQuery),
      ),
    [normalizedProjectQuery, projects],
  );
  const recordTagOptions = useMemo(
    () => {
      const tagMap = new Map<number, { id: number; label: string; colorKey: TagColorKey }>();

      for (const record of records) {
        for (const tag of record.tags) {
          if (!tagMap.has(tag.id)) {
            tagMap.set(tag.id, tag);
          }
        }
      }

      return Array.from(tagMap.values()).sort((left, right) =>
        left.label.localeCompare(right.label, "zh-Hans-CN"),
      );
    },
    [records],
  );

  const projectContextProject = projectContextMenu
    ? projects.find((project) => project.id === projectContextMenu.projectId) ?? null
    : null;

  function beginRenameProject(project: ProjectListItem) {
    setProjectContextMenu(null);
    setEditingProjectId(project.id);
    setProjectNameDraft(project.name);
  }

  function cancelRenameProject() {
    setEditingProjectId(null);
    setProjectNameDraft("");
  }

  function commitRenameProject(project: ProjectListItem) {
    const nextName = projectNameDraft.trim();
    cancelRenameProject();
    if (!nextName || nextName === project.name) {
      return;
    }
    void onRenameProject(project, nextName);
  }

  const projectContextMenuActions = useMemo<ContextMenuAction[]>(
    () =>
      projectContextProject
        ? [
            {
              label: "重命名",
              icon: Pencil,
              onSelect: () => beginRenameProject(projectContextProject),
            },
            {
              label: "归档",
              icon: Archive,
              onSelect: () => {
                onArchiveProject(projectContextProject.id);
                setProjectContextMenu(null);
              },
            },
            {
              label: "在新窗口中打开",
              icon: ExternalLink,
              onSelect: () => {
                onOpenProjectInNewWindow(projectContextProject.id);
                setProjectContextMenu(null);
              },
            },
            { type: "separator" },
            {
              label: "删除",
              icon: Trash2,
              tone: "danger",
              onSelect: () => {
                setDeleteConfirmProject(projectContextProject);
                setProjectContextMenu(null);
              },
            },
          ]
        : [],
    [onArchiveProject, onDeleteProject, onOpenProjectInNewWindow, projectContextProject],
  );

  if (projectSidebarCollapsed) {
    return (
      <aside className="sidebar-dock sidebar-dock--left" aria-label="工作区导航侧边栏">
        <button
          type="button"
          title={`展开 Workspace 侧边栏\n${workspaceRootPath}`}
          aria-label="展开工作区侧边栏"
          className="sidebar-dock__surface sidebar-dock__surface--icon-only"
          onClick={toggleProjectSidebarCollapsed}
        >
          <span className="sidebar-dock__icon">
            <FolderKanban size={16} />
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-border bg-[color-mix(in_srgb,var(--color-bg-subtle)_88%,var(--color-bg))]",
      )}
      style={{ width: `${projectSidebarWidthPx}px` }}
      aria-label="工作区导航侧边栏"
    >
      <ResizeHandle
        label="调整工作区侧边栏宽度"
        edge="right"
        value={projectSidebarWidthPx}
        min={PROJECT_SIDEBAR_WIDTH_MIN_PX}
        max={PROJECT_SIDEBAR_WIDTH_MAX_PX}
        onChange={setProjectSidebarWidthPx}
        className="right-0"
      />

      <div className="relative border-b border-border px-3 py-3">
        <button
          type="button"
          title={`Workspace\n${workspaceRootPath}`}
          className={cn(
            "rounded-[var(--radius-8)] border border-transparent text-text transition-colors hover:border-border hover:bg-bg",
            "flex w-full items-center gap-3 px-3 py-2.5 pr-12 text-left",
          )}
          onClick={onOpenOverview}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-8)] bg-bg text-text-muted">
            <FolderKanban size={16} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-title font-medium">Workspace</span>
            <span className="mt-1 flex items-center gap-2">
              <StatusBadge tone="neutral">workspace</StatusBadge>
            </span>
          </span>
        </button>
        <IconButton
          type="button"
          size="sm"
          variant="secondary"
          className="absolute right-3 top-3"
          aria-label="收起工作区侧边栏"
          onClick={toggleProjectSidebarCollapsed}
        >
          <ChevronLeft size={14} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3">
        <div className="grid shrink-0 gap-3">
          <SidebarTabs
            ariaLabel="工作区侧边栏视图"
            value={activeTab}
            options={WORKSPACE_SIDEBAR_TABS}
            onValueChange={setActiveTab}
          />

          {activeTab === "projects" ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              block
              disabled={createProjectPending}
              onClick={onCreateProject}
            >
              {createProjectPending ? "创建中..." : "新建项目"}
            </Button>
          ) : null}

          <div className="flex items-center gap-2">
            <SearchField
              aria-label={activeTab === "projects" ? "搜索项目" : "搜索记录"}
              placeholder={activeTab === "projects" ? "搜索项目" : "搜索记录标题或正文"}
              value={activeTab === "projects" ? projectQuery : recordQuery}
              onChange={(event) =>
                activeTab === "projects"
                  ? setProjectQuery(event.target.value)
                  : onRecordQueryChange(event.target.value)
              }
              className="flex-1"
            />
            {activeTab === "records" ? (
              <IconButton
                type="button"
                size="sm"
                variant="secondary"
                aria-label="新增记录"
                onClick={onCreateRecord}
              >
                <NotebookText size={14} />
              </IconButton>
            ) : null}
          </div>

          {activeTab === "records" && recordTagOptions.length > 0 ? (
            <SidebarFilters
              ariaLabel="Workspace Record 标签筛选"
              value={activeRecordTagId}
              options={recordTagOptions.map((tag) => ({
                value: tag.id,
                label: tag.label,
              }))}
              onValueChange={onActiveRecordTagIdChange}
            />
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {activeTab === "projects" ? (
              <div className="grid gap-1.5">
                {filteredProjects.length > 0 ? (
                  filteredProjects.map((project) => {
                    const isEditing = editingProjectId === project.id;

                    return (
                      <button
                        key={project.id}
                        type="button"
                        className="flex min-w-0 items-start gap-2 rounded-[var(--radius-8)] border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-bg"
                        onClick={() => {
                          if (!isEditing) {
                            onOpenProject(project.id);
                          }
                        }}
                        onPointerEnter={() => onPrefetchProject?.(project.id)}
                        onFocus={() => onPrefetchProject?.(project.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          if (isEditing) {
                            return;
                          }
                          setProjectContextMenu({
                            projectId: project.id,
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                      >
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-6)] bg-bg text-text-soft">
                          <FolderKanban size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          {isEditing ? (
                            <input
                              autoFocus
                              value={projectNameDraft}
                              className="inline-object-input h-6 min-w-0 w-full px-1.5 text-body font-medium text-text outline-none"
                              onChange={(event) => setProjectNameDraft(event.target.value)}
                              onClick={(event) => event.stopPropagation()}
                              onBlur={() => commitRenameProject(project)}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelRenameProject();
                                } else if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitRenameProject(project);
                                }
                              }}
                            />
                          ) : (
                            <p
                              className="truncate text-body font-medium text-text"
                              onDoubleClick={(event) => {
                                event.stopPropagation();
                                beginRenameProject(project);
                              }}
                            >
                              {project.name}
                            </p>
                          )}
                          <p className="mt-1 text-ui text-text-soft">
                            {project.openTodoCount} 个 Todo
                          </p>
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-4 text-ui text-text-soft">
                    没有匹配的项目。
                  </p>
                )}
              </div>
            ) : (
              <div className="grid gap-1.5">
                {records.length > 0 ? (
                  records.map((record) => (
                    <button
                      key={record.id}
                      type="button"
                      className={cn(
                        "flex min-w-0 items-start gap-2 rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-colors",
                        record.id === activeRecordId
                          ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))]"
                          : "border-transparent hover:border-border hover:bg-bg",
                      )}
                      onClick={() => onOpenRecord(record.id)}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        onFocusRecord?.(record.id);
                      }}
                    >
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-6)] bg-bg text-text-soft">
                        <NotebookText size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <p className="truncate text-body font-medium text-text">
                          {record.title || "未命名记录"}
                        </p>
                        <p className="mt-1 truncate text-ui text-text-soft">{record.contentMarkdown || "空记录"}</p>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-4 text-ui text-text-soft">
                    没有匹配的记录。
                  </p>
                )}
              </div>
            )}
          </div>

          {activeTab === "projects" ? (
            <div className="mt-3 border-t border-border pt-3">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-colors",
                  "border-[color-mix(in_srgb,var(--color-border-strong)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_35%,var(--color-bg-subtle))]",
                  "hover:border-border-strong hover:bg-bg",
                )}
                onClick={() => setArchiveDialogOpen(true)}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-8)] bg-bg text-text-muted">
                    <Archive size={15} />
                  </span>
                  <span className="min-w-0 text-body font-medium text-text">归档项目</span>
                </span>
                <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] font-medium text-text-soft">
                  {archivedProjects.length}
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {projectContextMenu ? (
        <ActionContextMenu
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          actions={projectContextMenuActions}
          ariaLabel="项目操作"
          onClose={() => setProjectContextMenu(null)}
        />
      ) : null}

      <Dialog
        open={deleteConfirmProject !== null}
        title="删除项目"
        description="删除后项目目录会移到废纸篓，项目中的 Record、Todo 和文件关联也会从当前 Workspace 移除。"
        widthClassName="max-w-lg"
        onClose={() => setDeleteConfirmProject(null)}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteConfirmProject(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                if (!deleteConfirmProject) {
                  return;
                }

                onDeleteProject(deleteConfirmProject);
                setDeleteConfirmProject(null);
              }}
            >
              删除项目
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="rounded-[var(--radius-8)] border border-danger/30 bg-danger/8 px-4 py-3">
            <p className="text-body font-medium text-text">
              {deleteConfirmProject?.name}
            </p>
            <p className="mt-1 break-all text-ui leading-5 text-text-soft">
              {deleteConfirmProject?.rootPath}
            </p>
          </div>
          <p className="text-ui leading-6 text-text-muted">
            请确认你确实要删除这个项目。这个操作会立即执行。
          </p>
        </div>
      </Dialog>

      <Dialog
        open={archiveDialogOpen}
        title="归档项目"
        description="归档不会删除项目内容。你可以临时打开查看，或恢复到当前 Workspace 的项目列表。"
        widthClassName="max-w-2xl"
        bodyClassName="space-y-3"
        onClose={() => setArchiveDialogOpen(false)}
      >
        {archivedProjects.length > 0 ? (
          archivedProjects.map((project) => (
            <section
              key={project.id}
              className="rounded-[var(--radius-10)] border border-border bg-[color-mix(in_srgb,var(--color-bg-subtle)_70%,var(--color-bg))] px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-body font-medium text-text">{project.name}</h3>
                    <StatusBadge tone="neutral">archived</StatusBadge>
                  </div>
                  <p className="mt-1 truncate text-ui text-text-soft">{project.rootPath}</p>
                  <p className="mt-2 text-ui text-text-soft">
                    {project.openTodoCount} 个待办待跟进
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setArchiveDialogOpen(false);
                      onOpenArchivedProject(project.id);
                    }}
                  >
                    打开
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onRestoreArchivedProject(project.id)}
                  >
                    恢复
                  </Button>
                </div>
              </div>
            </section>
          ))
        ) : (
          <div className="rounded-[var(--radius-10)] border border-dashed border-border px-4 py-8 text-center">
            <p className="text-body font-medium text-text">暂无归档项目</p>
            <p className="mt-2 text-ui text-text-soft">
              需要收起暂时不推进的项目时，可在项目列表右键归档，之后会统一出现在这里。
            </p>
          </div>
        )}
      </Dialog>
    </aside>
  );
}
