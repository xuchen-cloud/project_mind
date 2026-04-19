import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderKanban,
  Lightbulb,
  ListTodo,
  Plus,
} from "lucide-react";

import { resolveActivityTitle } from "../../lib/constants";
import type { FileTagColorKey } from "../../lib/types";
import { useUiStore } from "../../state/ui-store";
import {
  DeleteContextMenu,
  IconButton,
  StatusBadge,
} from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { ActivityAttributeTag } from "../activity/ActivityAttributeTag";
import { ActivityStatusTag } from "../activity/ActivityStatusTag";

export interface ProjectSidebarActivityItem {
  id: number;
  title: string;
  activityTime: string;
  attributeLabel?: string | null;
  attributeColorKey?: FileTagColorKey | null;
  conclusionCount: number;
  documentCount: number;
  completedTodoCount: number;
  totalTodoCount: number;
  statusLabel: string;
  statusColorKey: FileTagColorKey;
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
  onCreateActivity: () => void;
  onDeleteActivity: (activityId: number) => void;
}

function activityMonogram(title: string, index: number) {
  const normalized = title.trim();
  return normalized.length > 0
    ? normalized.slice(0, 1).toUpperCase()
    : String(index + 1);
}

export function ProjectSidebar({
  project,
  activities,
  activeActivityId = null,
  onOpenProject,
  onOpenActivity,
  onCreateActivity,
  onDeleteActivity,
}: ProjectSidebarProps) {
  const { projectSidebarCollapsed, toggleProjectSidebarCollapsed } =
    useUiStore();
  const [contextMenu, setContextMenu] = useState<{
    activityId: number;
    x: number;
    y: number;
  } | null>(null);
  const contextMenuActivity = useMemo(
    () =>
      activities.find((activity) => activity.id === contextMenu?.activityId) ??
      null,
    [activities, contextMenu],
  );

  useEffect(() => {
    if (contextMenu && !contextMenuActivity) {
      setContextMenu(null);
    }
  }, [contextMenu, contextMenuActivity]);

  const handleActivityContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    activityId: number,
  ) => {
    event.preventDefault();
    setContextMenu({
      activityId,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <>
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col border-r border-border bg-[color-mix(in_srgb,var(--color-bg-subtle)_88%,var(--color-bg))] transition-[width] duration-[160ms] ease-[var(--ease-soft)]",
          projectSidebarCollapsed ? "w-14" : "w-72",
        )}
        aria-label="项目导航侧边栏"
      >
        <div
          className={cn(
            "relative border-b border-border bg-[color-mix(in_srgb,var(--color-bg)_42%,var(--color-bg-subtle))]",
            projectSidebarCollapsed ? "px-2 py-3" : "px-3 py-3",
          )}
        >
          <div
            className={cn(
              "flex gap-2",
              projectSidebarCollapsed ? "flex-col items-center" : "items-start",
            )}
          >
            <button
              type="button"
              title={`${project.name}\n${project.rootPath}`}
              className={cn(
                "rounded-[var(--radius-8)] border border-transparent bg-transparent text-text transition-[border-color,background-color,color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] hover:border-border hover:bg-bg hover:shadow-[var(--shadow-sm)]",
                projectSidebarCollapsed
                  ? "flex h-9 w-9 items-center justify-center"
                  : "flex flex-1 items-center gap-3 px-3 py-2.5 pr-14 text-left",
              )}
              onClick={onOpenProject}
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
                    <StatusBadge tone="neutral">
                      {project.isArchived ? "archived" : "overview"}
                    </StatusBadge>
                  </span>
                </span>
              )}
            </button>

            <IconButton
              type="button"
              size="sm"
              variant={projectSidebarCollapsed ? "ghost" : "secondary"}
              className={
                projectSidebarCollapsed
                  ? undefined
                  : "absolute top-3 right-3 z-10 shadow-[var(--shadow-sm)]"
              }
              aria-label={
                projectSidebarCollapsed ? "展开项目侧边栏" : "收起项目侧边栏"
              }
              onClick={toggleProjectSidebarCollapsed}
            >
              {projectSidebarCollapsed ? (
                <ChevronRight size={14} />
              ) : (
                <ChevronLeft size={14} />
              )}
            </IconButton>
          </div>
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto",
            projectSidebarCollapsed ? "px-2 py-3" : "px-3 py-3",
          )}
        >
          {projectSidebarCollapsed ? (
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                aria-label="新建 Activity"
                title="新建 Activity"
                className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-8)] border border-dashed border-border bg-transparent text-text-muted transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong hover:bg-bg hover:text-text"
                onClick={onCreateActivity}
              >
                <Plus size={16} />
              </button>
              {activities.map((activity, index) => (
                <button
                  key={activity.id}
                  type="button"
                  title={resolveActivityTitle(activity.title, activity.id)}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-[var(--radius-8)] border text-ui font-medium transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
                    activity.id === activeActivityId
                      ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                      : "border-transparent bg-transparent text-text-muted hover:border-border hover:bg-bg-hover hover:text-text",
                  )}
                  onClick={() => onOpenActivity(activity.id)}
                  onContextMenu={(event) =>
                    handleActivityContextMenu(event, activity.id)
                  }
                >
                  {activityMonogram(
                    resolveActivityTitle(activity.title, activity.id),
                    index,
                  )}
                </button>
              ))}
            </div>
          ) : activities.length > 0 ? (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2 px-1">
                <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                  Activities
                </p>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-[var(--radius-6)] border border-transparent px-2 py-1 text-ui font-medium text-text-muted transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border hover:bg-bg hover:text-text"
                  onClick={onCreateActivity}
                >
                  <Plus size={14} />
                  <span>新建 Activity</span>
                </button>
              </div>
              {activities.map((activity) => (
                <button
                  key={activity.id}
                  id={`activity-${activity.id}`}
                  type="button"
                  className={cn(
                    "rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)]",
                    activity.id === activeActivityId
                      ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] shadow-[var(--shadow-sm)]"
                      : "border-transparent bg-transparent hover:border-border hover:bg-bg hover:shadow-[var(--shadow-sm)]",
                  )}
                  onClick={() => onOpenActivity(activity.id)}
                  onContextMenu={(event) =>
                    handleActivityContextMenu(event, activity.id)
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {activity.attributeLabel ? (
                      <ActivityAttributeTag
                        label={activity.attributeLabel}
                        colorKey={activity.attributeColorKey ?? null}
                      />
                    ) : null}
                    <p className="text-body font-medium leading-5 text-text">
                      {resolveActivityTitle(activity.title, activity.id)}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-ui text-text-soft">
                    <ActivityStatusTag
                      label={activity.statusLabel}
                      colorKey={activity.statusColorKey}
                    />
                    <span
                      className="inline-flex items-center gap-1 opacity-75"
                      aria-label={`文件 ${activity.documentCount}`}
                      title={`文件 ${activity.documentCount}`}
                    >
                      <FileText size={13} aria-hidden="true" />
                      <span>{activity.documentCount}</span>
                    </span>
                    <span
                      className="inline-flex items-center gap-1 opacity-75"
                      aria-label={`结论 ${activity.conclusionCount}`}
                      title={`结论 ${activity.conclusionCount}`}
                    >
                      <Lightbulb size={13} aria-hidden="true" />
                      <span>{activity.conclusionCount}</span>
                    </span>
                    <span
                      className="inline-flex items-center gap-1 opacity-75"
                      aria-label={`Todo ${activity.completedTodoCount}/${activity.totalTodoCount}`}
                      title={`Todo ${activity.completedTodoCount}/${activity.totalTodoCount}`}
                    >
                      <ListTodo size={13} aria-hidden="true" />
                      <span>
                        {activity.completedTodoCount}/{activity.totalTodoCount}
                      </span>
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="grid gap-2 px-1">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-8)] border border-dashed border-border bg-transparent px-3 py-2 text-ui font-medium text-text-muted transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong hover:bg-bg hover:text-text"
                onClick={onCreateActivity}
              >
                <Plus size={14} />
                <span>新建 Activity</span>
              </button>
              <p className="px-1 text-ui text-text-soft">还没有 activity。</p>
            </div>
          )}
        </div>
      </aside>

      {contextMenu && contextMenuActivity ? (
        <DeleteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Activity 操作"
          onClose={() => setContextMenu(null)}
          onDelete={() => onDeleteActivity(contextMenuActivity.id)}
        />
      ) : null}
    </>
  );
}
