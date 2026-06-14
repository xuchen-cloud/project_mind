import {
  CalendarDays,
  CircleX,
  LoaderCircle,
  Settings2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  ProjectListItem,
  WorkspaceSearchResult,
} from "../../lib/types";
import {
  ActionContextMenu,
  IconButton,
  PopoverPanel,
  SearchField,
  StatusBadge,
} from "../../ui/components";

interface WorkspaceTopBarProps {
  projects: ProjectListItem[];
  activeProjectId: number | null;
  todayActive?: boolean;
  showToday?: boolean;
  settingsActive?: boolean;
  searchInput: string;
  onSearchInput: (value: string) => void;
  searchResults: WorkspaceSearchResult[];
  searching: boolean;
  onOpenProject: (projectId: number) => void;
  onCloseProject?: (projectId: number) => void;
  onOpenToday: () => void;
  onOpenSettings: () => void;
  onSearchSelect: (result: WorkspaceSearchResult) => void;
  onDetachProject?: (projectId: number) => void;
}

export function shouldDetachProjectTabRelease(input: {
  tabListRect: Pick<DOMRect, "left" | "right" | "top" | "bottom"> | null;
  dragging: boolean;
  clientX: number;
  clientY: number;
}) {
  return (
    input.dragging &&
    input.tabListRect !== null &&
    (input.clientX < input.tabListRect.left ||
      input.clientX > input.tabListRect.right ||
      input.clientY < input.tabListRect.top ||
      input.clientY > input.tabListRect.bottom)
  );
}

export function WorkspaceTopBar({
  projects,
  activeProjectId,
  todayActive = false,
  showToday = true,
  settingsActive = false,
  searchInput,
  onSearchInput,
  searchResults,
  searching,
  onOpenProject,
  onCloseProject,
  onOpenToday,
  onOpenSettings,
  onSearchSelect,
  onDetachProject,
}: WorkspaceTopBarProps) {
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    projectId: number;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const [projectTabContextMenu, setProjectTabContextMenu] = useState<{
    projectId: number;
    x: number;
    y: number;
  } | null>(null);
  const [draggingProjectId, setDraggingProjectId] = useState<number | null>(null);
  const dragEnabled = Boolean(onDetachProject);

  useEffect(() => {
    if (!dragEnabled) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }

      const deltaX = event.clientX - state.startX;
      const deltaY = event.clientY - state.startY;

      if (!state.dragging && Math.hypot(deltaX, deltaY) >= 10) {
        state.dragging = true;
        setDraggingProjectId(state.projectId);
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }

      const tabListRect = tabListRef.current?.getBoundingClientRect() ?? null;
      const releasedOutsideTabList = shouldDetachProjectTabRelease({
        tabListRect,
        dragging: state.dragging,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      const projectId = state.projectId;
      dragStateRef.current = null;
      setDraggingProjectId(null);

      if (releasedOutsideTabList) {
        onDetachProject?.(projectId);
      }
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (dragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }

      dragStateRef.current = null;
      setDraggingProjectId(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [dragEnabled, onDetachProject]);

  const tabClassName = useMemo(
    () =>
      [
        "workspace-topbar__tab group inline-flex h-8 min-w-0 items-center rounded-[var(--radius-6)] border pr-0.5 text-ui font-medium transition-[background-color,color,border-color,opacity] duration-[160ms] ease-[var(--ease-soft)]",
      ].join(" "),
    [],
  );

  const projectTabContextMenuPortal =
    projectTabContextMenu && onDetachProject && typeof document !== "undefined"
      ? createPortal(
          <ActionContextMenu
            x={projectTabContextMenu.x}
            y={projectTabContextMenu.y}
            ariaLabel="项目页签操作"
            actions={[
              {
                label: "在新窗口中打开",
                onSelect: () => {
                  onDetachProject(projectTabContextMenu.projectId);
                  setProjectTabContextMenu(null);
                },
              },
            ]}
            onClose={() => setProjectTabContextMenu(null)}
          />,
          document.body,
        )
      : null;

  return (
    <header className="workspace-topbar sticky top-0 z-20 flex h-10 items-center justify-between gap-4 border-b border-border bg-bg/95 px-3 backdrop-blur-sm">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <div
          ref={tabListRef}
          className="workspace-topbar__tablist flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
          role="tablist"
          aria-label="Projects"
        >
          {showToday ? (
            <button
              type="button"
              className={[
                "workspace-topbar__tab workspace-topbar__tab--workspace inline-flex h-8 min-w-0 items-center gap-1 rounded-[var(--radius-6)] border px-2 text-ui font-medium transition-[background-color,color,border-color] duration-[160ms] ease-[var(--ease-soft)]",
                todayActive ? "workspace-topbar__tab--active" : "",
                todayActive
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                  : "border-transparent text-text-muted hover:bg-bg-hover hover:text-text",
              ].join(" ")}
              onClick={onOpenToday}
              title="Workspace"
            >
              <CalendarDays size={14} />
              <span className="workspace-topbar__tab-label min-w-0 flex-1">Workspace</span>
            </button>
          ) : null}
          {projects.map((project) => (
            <div
              key={project.id}
              className={[
                tabClassName,
                project.id === activeProjectId ? "workspace-topbar__tab--active" : "",
                project.id === activeProjectId
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                  : "border-transparent text-text-muted hover:bg-bg-hover hover:text-text",
                draggingProjectId === project.id ? "opacity-60" : "",
              ].join(" ")}
              role="presentation"
            >
              <button
                type="button"
                className="workspace-topbar__tab-trigger flex h-full min-w-0 flex-1 items-center overflow-hidden rounded-[var(--radius-6)] px-2"
                onClick={() => onOpenProject(project.id)}
                onContextMenu={(event) => {
                  if (!onDetachProject) {
                    return;
                  }

                  event.preventDefault();
                  setProjectTabContextMenu({
                    projectId: project.id,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onPointerDown={(event) => {
                  if (!dragEnabled || event.button !== 0) {
                    return;
                  }

                  dragStateRef.current = {
                    projectId: project.id,
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    dragging: false,
                  };
                }}
                title={project.name}
              >
                <span className="workspace-topbar__tab-label min-w-0 flex-1">{project.name}</span>
              </button>
              {onCloseProject ? (
                <button
                  type="button"
                  aria-label={`关闭 ${project.name}`}
                  className={[
                    "workspace-topbar__tab-close inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-current opacity-55 transition-[background-color,opacity] hover:bg-bg/80 hover:opacity-100",
                    project.id === activeProjectId ? "workspace-topbar__tab-close--persistent" : "",
                  ].join(" ")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseProject(project.id);
                  }}
                >
                  <CircleX size={12} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="workspace-topbar__actions flex shrink-0 items-center gap-2">
        <div className="workspace-topbar__search relative">
          <SearchField
            value={searchInput}
            onChange={(event) => onSearchInput(event.target.value)}
            placeholder="搜索项目、活动、记录、结论、Todo、文件"
            className="w-64"
            loading={searching}
          />

          {searchInput.trim() ? (
            <PopoverPanel className="absolute right-0 top-[calc(100%+6px)] z-20 max-h-96 w-80 overflow-auto">
              {searching ? (
                <div className="flex items-center gap-2 px-2 py-2 text-ui text-text-soft">
                  <LoaderCircle className="spin" size={14} />
                  搜索中...
                </div>
              ) : searchResults.length > 0 ? (
                <div className="py-1">
                  {searchResults.map((result) => (
                    <button
                      key={`${result.kind}-${result.id}`}
                      type="button"
                      className="w-full rounded-[var(--radius-6)] bg-transparent px-2 py-2 text-left transition-colors hover:bg-bg-hover"
                      onClick={() => onSearchSelect(result)}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <p className="truncate text-body font-medium text-text">
                          {result.title || "Untitled"}
                        </p>
                        <StatusBadge tone="neutral">{result.kind}</StatusBadge>
                      </div>
                      <p className="truncate text-ui text-text-soft">
                        {result.subtitle || result.matchedText}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-3 text-center text-ui text-text-soft">没有匹配结果</div>
              )}
            </PopoverPanel>
          ) : null}
        </div>

        <IconButton
          type="button"
          size="md"
          aria-label="设置"
          className={settingsActive ? "text-accent" : undefined}
          onClick={onOpenSettings}
        >
          <Settings2 size={13} />
        </IconButton>
      </div>

      {projectTabContextMenuPortal}
    </header>
  );
}
