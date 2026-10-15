import { RecordIcon } from "../icons/ContentTypeIcon";
import { SidebarTagItem } from "../home/SidebarTagItem";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { HomeSidebarSplit } from "../home/HomeSidebarSplit";
import { HomeSidebarFooter, HomeWorkspaceIdentity } from "../home/HomeWorkspaceIdentity";
import { ProjectHomeIcon } from "../home/HomeCover";
import {
Archive,
PanelLeft, ChevronLeft,
ExternalLink,
FolderKanban,
Pencil,
Plus,
Trash2
} from "lucide-react";
import { useMemo,useState } from "react";

import noriBust from "../../assets/home/nori-bust.png";
import noriWordmark from "../../assets/home/norimind-wordmark.svg";
import type { ProjectListItem,TagColorKey } from "../../lib/types";
import {
PROJECT_SIDEBAR_WIDTH_MAX_PX,
PROJECT_SIDEBAR_WIDTH_MIN_PX,
useUiStore,
} from "../../state/ui-store";
import {
ActionContextMenu,
Button,
Dialog,
ResizeHandle,
SearchField,
StatusBadge,
type ContextMenuAction
} from "../../ui/components";
import { cn } from "../../ui/lib/cn";

export interface WorkspaceOverviewSidebarRecordItem {
  id: number;
  isVoice?: boolean;
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
  availableTags?: Array<{ id: number; label: string; colorKey: TagColorKey }>;
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
  onRenameRecord?: (
    record: WorkspaceOverviewSidebarRecordItem,
    title: string,
  ) => Promise<unknown> | unknown;
  onDeleteRecord?: (
    record: WorkspaceOverviewSidebarRecordItem,
  ) => Promise<unknown> | unknown;
}

export function WorkspaceOverviewSidebar({
  workspaceRootPath,
  projects,
  archivedProjects,
  records,
  availableTags = [],
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
  onRenameRecord,
  onDeleteRecord,
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
        "home-side",
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

      <div data-tauri-drag-region className="home-side__top"><button type="button" aria-label="切换左侧栏" aria-expanded={true} onClick={toggleProjectSidebarCollapsed}><PanelLeft size={16} /></button><button type="button" className="home-side__workspace-tab" onClick={onOpenOverview}>我的工作区</button></div>
      <div className="home-side__brand"><img className="home-side__mascot" src={noriBust} alt="" /><div className="home-side__brand-copy"><img className="home-side__wordmark" src={noriWordmark} alt="NoriMind" /><HomeWorkspaceIdentity onOpenWorkspace={onOpenOverview} /></div><button type="button" aria-label="收起工作区侧边栏" onClick={toggleProjectSidebarCollapsed}><ChevronLeft size={17} /></button></div>

      <HomeSidebarSplit key={workspaceRootPath} storageKey={`home-sidebar-split:workspace:${workspaceRootPath}`} upper={<><div className="home-side__heading"><span>项目</span><div className="home-side__heading-actions"><button type="button" className="home-side__workspace-action" aria-label="归档项目" title="归档项目" onClick={() => setArchiveDialogOpen(true)}><Archive size={13} /></button><button type="button" className="home-side__workspace-action" aria-label="新建项目" title="新建项目" disabled={createProjectPending} onClick={onCreateProject}><Plus size={13} /></button></div></div>
              <SearchField className="home-side__search" aria-label="搜索项目" placeholder="搜索项目" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} />
              <HomeSidebarList label="项目列表" searchKey={projectQuery}>
                {filteredProjects.length > 0 ? (
                  filteredProjects.map((project) => {
                    const isEditing = editingProjectId === project.id;

                    return (
                      <button
                        key={project.id}
                        type="button"
                        className="home-side__project"
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
                        <span className="home-side__project-icon">
                          <ProjectHomeIcon rootPath={project.rootPath} size={18} />
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

                        </span>
                      </button>
                    );
                  })
                ) : (
                  <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-4 text-ui text-text-soft">
                    没有匹配的项目。
                  </p>
                )}
              </HomeSidebarList>

        </>} lower={<><div className="home-side__heading">工作区标签</div><HomeSidebarList label="工作区标签列表">
        <button type="button" className="home-side__item" onClick={() => onActiveRecordTagIdChange(null)}><RecordIcon size={18} />全部记录</button>
        {availableTags.map((tag) => <SidebarTagItem key={tag.id} tag={tag} projectId={null} selected={activeRecordTagId === tag.id} onSelect={onActiveRecordTagIdChange} />)}
      </HomeSidebarList></>} />

      <HomeSidebarFooter />
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
