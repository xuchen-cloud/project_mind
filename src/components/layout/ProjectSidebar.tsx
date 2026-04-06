import { ChevronLeft, ChevronRight, FolderKanban } from "lucide-react";

import { activityAttributeLabel, activityStatusTone } from "../../lib/constants";
import { formatDateTime } from "../../lib/formatters";
import { desktopApi } from "../../services/desktopApi";
import { useUiStore } from "../../state/ui-store";
import { IconButton, StatusBadge } from "../../ui/components";
import { cn } from "../../ui/lib/cn";

export interface ProjectSidebarActivityItem {
  id: number;
  title: string;
  activityTime: string;
  attributeLabel?: string | null;
  documentCount: number;
  completedTodoCount: number;
  totalTodoCount: number;
  statusLabel: string;
  statusNeedsAttention: boolean;
}

interface ProjectSidebarProps {
  project: {
    name: string;
    rootPath: string;
    isArchived?: boolean;
  };
  activities: ProjectSidebarActivityItem[];
  activeActivityId?: number | null;
  onOpenProject: () => void;
  onOpenActivity: (activityId: number) => void;
}

function activityMonogram(title: string, index: number) {
  const normalized = title.trim();
  return normalized.length > 0 ? normalized.slice(0, 1).toUpperCase() : String(index + 1);
}

export function ProjectSidebar({
  project,
  activities,
  activeActivityId = null,
  onOpenProject,
  onOpenActivity,
}: ProjectSidebarProps) {
  const { projectSidebarCollapsed, toggleProjectSidebarCollapsed } = useUiStore();
  const handleOpenProject = () => {
    onOpenProject();
    void desktopApi.openFolder(project.rootPath).catch(() => undefined);
  };

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-bg-subtle transition-[width] duration-[160ms] ease-[var(--ease-soft)]",
        projectSidebarCollapsed ? "w-14" : "w-72",
      )}
      aria-label="项目导航侧边栏"
    >
      <div className={cn("border-b border-border", projectSidebarCollapsed ? "px-2 py-3" : "px-3 py-4")}>
        <div
          className={cn(
            "flex gap-2",
            projectSidebarCollapsed ? "flex-col items-center" : "items-start justify-between",
          )}
        >
          <button
            type="button"
            title={`${project.name}\n${project.rootPath}`}
            className={cn(
              "rounded-[var(--radius-8)] border transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
              activeActivityId === null
                ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                : "border-transparent bg-transparent text-text-muted hover:border-border hover:bg-bg-hover hover:text-text",
              projectSidebarCollapsed
                ? "flex h-9 w-9 items-center justify-center"
                : "flex flex-1 items-center gap-3 px-3 py-3 text-left",
            )}
            onClick={handleOpenProject}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-8)] bg-bg text-text-muted">
              <FolderKanban size={16} />
            </span>
            {projectSidebarCollapsed ? null : (
              <span className="min-w-0">
                <span className="block truncate text-title font-medium">
                  {project.name}
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <StatusBadge tone={project.isArchived ? "neutral" : "accent"}>
                    {project.isArchived ? "archived" : "overview"}
                  </StatusBadge>
                </span>
              </span>
            )}
          </button>

          <IconButton
            type="button"
            size="sm"
            aria-label={projectSidebarCollapsed ? "展开项目侧边栏" : "收起项目侧边栏"}
            onClick={toggleProjectSidebarCollapsed}
          >
            {projectSidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {projectSidebarCollapsed ? (
          <div className="flex flex-col items-center gap-2">
            {activities.map((activity, index) => (
              <button
                key={activity.id}
                type="button"
                title={`${activity.title || "Untitled Activity"} · ${formatDateTime(activity.activityTime)}`}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-[var(--radius-8)] border text-ui font-medium transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
                  activity.id === activeActivityId
                    ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                    : "border-transparent bg-transparent text-text-muted hover:border-border hover:bg-bg-hover hover:text-text",
                )}
                onClick={() => onOpenActivity(activity.id)}
              >
                {activityMonogram(activity.title, index)}
              </button>
            ))}
          </div>
        ) : activities.length > 0 ? (
          <div className="grid gap-2">
            <p className="px-2 text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              Activities
            </p>
            {activities.map((activity) => (
              <button
                key={activity.id}
                id={`activity-${activity.id}`}
                type="button"
                className={cn(
                  "rounded-[var(--radius-8)] border px-3 py-3 text-left transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)]",
                  activity.id === activeActivityId
                    ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))]"
                    : "border-border bg-bg hover:border-border-strong hover:bg-bg-hover",
                )}
                onClick={() => onOpenActivity(activity.id)}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <StatusBadge tone={activityStatusTone(activity.statusNeedsAttention)}>
                    {activity.statusLabel}
                  </StatusBadge>
                  <span className="text-caption text-text-soft">
                    {formatDateTime(activity.activityTime)}
                  </span>
                </div>
                <p className="line-clamp-2 text-body font-medium leading-5 text-text">
                  {activity.title || "Untitled Activity"}
                </p>
                <p className="mt-2 text-ui text-text-soft">
                  {activityAttributeLabel(activity.attributeLabel)} · {activity.documentCount} files ·{" "}
                  {activity.completedTodoCount}/{activity.totalTodoCount} todos
                </p>
              </button>
            ))}
          </div>
        ) : (
          <p className="px-2 text-ui text-text-soft">还没有 activity。</p>
        )}
      </div>
    </aside>
  );
}
