import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, FolderKanban, NotebookText } from "lucide-react";

import type { FileTagColorKey, ProjectListItem, WorkspaceRecord } from "../../lib/types";
import { useUiStore } from "../../state/ui-store";
import {
  ActionContextMenu,
  IconButton,
  SearchField,
  StatusBadge,
  type ContextMenuAction,
} from "../../ui/components";
import { cn } from "../../ui/lib/cn";

export interface WorkspaceOverviewSidebarRecordItem {
  id: number;
  title?: string | null;
  contentMarkdown: string;
  updatedAt: string;
}

type WorkspaceOverviewSidebarTab = "projects" | "records";

interface WorkspaceOverviewSidebarProps {
  workspaceRootPath: string;
  projects: ProjectListItem[];
  records: WorkspaceOverviewSidebarRecordItem[];
  activeRecordId?: number | null;
  onOpenOverview: () => void;
  onOpenProject: (projectId: number) => void;
  onOpenProjectInNewWindow: (projectId: number) => void;
  onOpenRecord: (recordId: number) => void;
  onCreateRecord: () => void;
}

export function WorkspaceOverviewSidebar({
  workspaceRootPath,
  projects,
  records,
  activeRecordId,
  onOpenOverview,
  onOpenProject,
  onOpenProjectInNewWindow,
  onOpenRecord,
  onCreateRecord,
}: WorkspaceOverviewSidebarProps) {
  const {
    projectSidebarCollapsed,
    projectSidebarWidthPx,
    toggleProjectSidebarCollapsed,
    setProjectSidebarWidthPx,
  } = useUiStore();
  const [activeTab, setActiveTab] = useState<WorkspaceOverviewSidebarTab>("projects");
  const [query, setQuery] = useState("");
  const [projectContextMenu, setProjectContextMenu] = useState<{
    projectId: number;
    x: number;
    y: number;
  } | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  const filteredProjects = useMemo(
    () =>
      projects.filter((project) =>
        !normalizedQuery || project.name.toLowerCase().includes(normalizedQuery),
      ),
    [normalizedQuery, projects],
  );
  const filteredRecords = useMemo(
    () =>
      records.filter((record) => {
        const title = record.title ?? "未命名记录";
        return (
          !normalizedQuery ||
          title.toLowerCase().includes(normalizedQuery) ||
          record.contentMarkdown.toLowerCase().includes(normalizedQuery)
        );
      }),
    [normalizedQuery, records],
  );

  const projectContextMenuActions = useMemo<ContextMenuAction[]>(
    () =>
      projectContextMenu
        ? [
            {
              label: "在新窗口中打开",
              onSelect: () => {
                onOpenProjectInNewWindow(projectContextMenu.projectId);
                setProjectContextMenu(null);
              },
            },
          ]
        : [],
    [onOpenProjectInNewWindow, projectContextMenu],
  );

  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-border bg-[color-mix(in_srgb,var(--color-bg-subtle)_88%,var(--color-bg))]",
        projectSidebarCollapsed ? "" : "transition-[width] duration-[160ms] ease-[var(--ease-soft)]",
      )}
      style={{ width: projectSidebarCollapsed ? "48px" : `${projectSidebarWidthPx}px` }}
      aria-label="工作区导航侧边栏"
    >
      {!projectSidebarCollapsed ? (
        <div
          className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-accent/20"
          onMouseDown={(event) => {
            event.preventDefault();
            const handleMouseMove = (moveEvent: MouseEvent) => {
              setProjectSidebarWidthPx(moveEvent.clientX);
            };
            const handleMouseUp = () => {
              document.removeEventListener("mousemove", handleMouseMove);
              document.removeEventListener("mouseup", handleMouseUp);
            };
            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
          }}
        />
      ) : null}

      <div className={cn("relative border-b border-border px-3 py-3", projectSidebarCollapsed && "px-2")}>
        <button
          type="button"
          title={`Workspace\n${workspaceRootPath}`}
          className={cn(
            "rounded-[var(--radius-8)] border border-transparent text-text transition-colors hover:border-border hover:bg-bg",
            projectSidebarCollapsed
              ? "flex h-9 w-9 items-center justify-center"
              : "flex w-full items-center gap-3 px-3 py-2.5 pr-12 text-left",
          )}
          onClick={onOpenOverview}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-8)] bg-bg text-text-muted">
            <FolderKanban size={16} />
          </span>
          {!projectSidebarCollapsed ? (
            <span className="min-w-0">
              <span className="block truncate text-title font-medium">Workspace</span>
              <span className="mt-1 flex items-center gap-2">
                <StatusBadge tone="neutral">workspace</StatusBadge>
              </span>
            </span>
          ) : null}
        </button>
        <IconButton
          type="button"
          size="sm"
          variant={projectSidebarCollapsed ? "ghost" : "secondary"}
          className={projectSidebarCollapsed ? undefined : "absolute right-3 top-3"}
          aria-label={projectSidebarCollapsed ? "展开工作区侧边栏" : "收起工作区侧边栏"}
          onClick={toggleProjectSidebarCollapsed}
        >
          {projectSidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </IconButton>
      </div>

      {projectSidebarCollapsed ? (
        <div className="flex flex-1 flex-col items-center gap-2 px-1.5 py-3">
          {(activeTab === "projects" ? filteredProjects : filteredRecords).slice(0, 12).map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-[var(--radius-8)] border text-ui font-medium",
                activeTab === "records" && item.id === activeRecordId
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                  : "border-transparent text-text-muted hover:border-border hover:bg-bg-hover hover:text-text",
              )}
              title={"name" in item ? item.name : item.title ?? "未命名记录"}
              onClick={() =>
                activeTab === "projects" ? onOpenProject(item.id) : onOpenRecord(item.id)
              }
            >
              {activeTab === "projects" ? (
                <span>{("name" in item ? item.name : "总").slice(0, 1)}</span>
              ) : (
                <NotebookText size={15} />
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3">
          <div className="grid shrink-0 gap-3">
            <div className="grid grid-cols-2 rounded-[var(--radius-8)] bg-bg p-1" role="tablist" aria-label="工作区侧边栏视图">
              <TabButton active={activeTab === "projects"} onClick={() => setActiveTab("projects")}>
                项目
              </TabButton>
              <TabButton active={activeTab === "records"} onClick={() => setActiveTab("records")}>
                记录
              </TabButton>
            </div>

            <div className="flex items-center gap-2">
              <SearchField
                aria-label={activeTab === "projects" ? "搜索项目" : "搜索记录"}
                placeholder={activeTab === "projects" ? "搜索项目" : "搜索记录标题或正文"}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
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
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {activeTab === "projects" ? (
              <div className="grid gap-1.5">
                {filteredProjects.length > 0 ? (
                  filteredProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="flex min-w-0 items-start gap-2 rounded-[var(--radius-8)] border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-bg"
                      onClick={() => onOpenProject(project.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
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
                        <p className="truncate text-body font-medium text-text">{project.name}</p>
                        <p className="mt-1 text-ui text-text-soft">{project.openTodoCount} 个待办</p>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-4 text-ui text-text-soft">
                    没有匹配的项目。
                  </p>
                )}
              </div>
            ) : (
              <div className="grid gap-1.5">
                {filteredRecords.length > 0 ? (
                  filteredRecords.map((record) => (
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
        </div>
      )}

      {projectContextMenu ? (
        <ActionContextMenu
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          actions={projectContextMenuActions}
          ariaLabel="项目操作"
          onClose={() => setProjectContextMenu(null)}
        />
      ) : null}
    </aside>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        "rounded-[var(--radius-6)] px-2 py-1.5 text-ui font-medium transition-colors",
        active ? "bg-bg-subtle text-text shadow-[var(--shadow-sm)]" : "text-text-soft hover:text-text",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
