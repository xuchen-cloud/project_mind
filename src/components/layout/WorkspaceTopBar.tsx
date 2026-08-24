import {
  CircleX,
  LoaderCircle,
  PanelsTopLeft,
  Search,
  Settings2,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { getRovingTabTargetIndex } from "../../ui/rovingTabs";

interface WorkspaceTopBarProps {
  projects: ProjectListItem[];
  activeProjectId: number | null;
  workspaceActive?: boolean;
  showWorkspace?: boolean;
  settingsActive?: boolean;
  searchInput: string;
  onSearchInput: (value: string) => void;
  searchResults: WorkspaceSearchResult[];
  searching: boolean;
  searchError?: boolean;
  onOpenProject: (projectId: number) => void;
  onPrefetchProject?: (projectId: number) => void;
  onCloseProject?: (projectId: number) => void;
  onOpenWorkspace: () => void;
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
  workspaceActive = false,
  showWorkspace = true,
  settingsActive = false,
  searchInput,
  onSearchInput,
  searchResults,
  searching,
  searchError = false,
  onOpenProject,
  onPrefetchProject,
  onCloseProject,
  onOpenWorkspace,
  onOpenSettings,
  onSearchSelect,
  onDetachProject,
}: WorkspaceTopBarProps) {
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const compactSearchTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  const [searchFocused, setSearchFocused] = useState(false);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(-1);
  const [compactSearchOpen, setCompactSearchOpen] = useState(false);
  const dragEnabled = Boolean(onDetachProject);

  useEffect(() => {
    setActiveSearchResultIndex(-1);
  }, [searchInput, searchResults]);

  useEffect(() => {
    if (compactSearchOpen) {
      searchRef.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
    }
  }, [compactSearchOpen]);

  const selectSearchResult = (result: WorkspaceSearchResult) => {
    setSearchFocused(false);
    setActiveSearchResultIndex(-1);
    setCompactSearchOpen(false);
    onSearchSelect(result);
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    activate: (tab: HTMLButtonElement) => void,
  ) => {
    if (!tabListRef.current) {
      return;
    }

    const tabs = Array.from(
      tabListRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0) {
      return;
    }

    const nextIndex = getRovingTabTargetIndex({
      key: event.key,
      currentIndex,
      itemCount: tabs.length,
    });

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    nextTab.focus();
    activate(nextTab);
  };

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
        "workspace-topbar__tab group inline-flex h-8 min-w-0 items-center rounded-[var(--radius-6)] border pr-0.5 text-ui font-medium transition-[background-color,color,border-color,opacity] duration-[var(--duration-standard)] ease-[var(--ease-soft)]",
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
          aria-label="Workspace 与项目"
        >
          {showWorkspace ? (
            <button
              type="button"
              className={[
                "workspace-topbar__tab workspace-topbar__tab--workspace inline-flex h-8 min-w-0 items-center gap-1 rounded-[var(--radius-6)] border px-2 text-ui font-medium transition-[background-color,color,border-color] duration-[var(--duration-standard)] ease-[var(--ease-soft)]",
                workspaceActive ? "workspace-topbar__tab--active" : "",
                workspaceActive
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                  : "border-transparent text-text-muted hover:bg-bg-hover hover:text-text",
              ].join(" ")}
              onClick={onOpenWorkspace}
              onKeyDown={(event) =>
                handleTabKeyDown(event, (tab) => tab.click())
              }
              role="tab"
              aria-selected={workspaceActive}
              tabIndex={workspaceActive || activeProjectId === null ? 0 : -1}
              title="Workspace"
            >
              <PanelsTopLeft size={14} />
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
                onKeyDown={(event) =>
                  handleTabKeyDown(event, (tab) => tab.click())
                }
                role="tab"
                aria-selected={project.id === activeProjectId}
                tabIndex={
                  project.id === activeProjectId ||
                  (!showWorkspace && activeProjectId === null && project === projects[0])
                    ? 0
                    : -1
                }
                onPointerEnter={() => onPrefetchProject?.(project.id)}
                onFocus={() => onPrefetchProject?.(project.id)}
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
        <IconButton
          ref={compactSearchTriggerRef}
          type="button"
          size="md"
          aria-label="打开全局搜索"
          aria-expanded={compactSearchOpen}
          aria-controls="workspace-global-search"
          className="workspace-topbar__search-toggle"
          onClick={() => setCompactSearchOpen(true)}
        >
          <Search size={14} />
        </IconButton>
        <div
          ref={searchRef}
          className={[
            "workspace-topbar__search relative",
            compactSearchOpen ? "workspace-topbar__search--compact-open" : "",
          ].join(" ")}
          onFocus={() => setSearchFocused(true)}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && searchRef.current?.contains(nextTarget)) {
              return;
            }
            setSearchFocused(false);
            setCompactSearchOpen(false);
          }}
        >
          <SearchField
            value={searchInput}
            onChange={(event) => onSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (searchResults.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSearchResultIndex((current) =>
                  current < searchResults.length - 1 ? current + 1 : 0,
                );
                return;
              }
              if (searchResults.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSearchResultIndex((current) =>
                  current > 0 ? current - 1 : searchResults.length - 1,
                );
                return;
              }
              if (
                event.key === "Enter" &&
                activeSearchResultIndex >= 0 &&
                searchResults[activeSearchResultIndex]
              ) {
                event.preventDefault();
                selectSearchResult(searchResults[activeSearchResultIndex]);
                return;
              }
              if (event.key === "Escape") {
                setSearchFocused(false);
                setActiveSearchResultIndex(-1);
                if (compactSearchOpen) {
                  setCompactSearchOpen(false);
                  compactSearchTriggerRef.current?.focus();
                }
              }
            }}
            id="workspace-global-search"
            role="combobox"
            aria-label="全局搜索"
            aria-autocomplete="list"
            aria-expanded={searchFocused}
            aria-controls="workspace-search-results"
            aria-activedescendant={
              activeSearchResultIndex >= 0
                ? `workspace-search-result-${activeSearchResultIndex}`
                : undefined
            }
            placeholder="搜索 Workspace、项目、记录、Todo、文件、联系人"
            className="w-64"
            loading={searching}
          />

          {searchFocused ? (
            <PopoverPanel
              id="workspace-search-results"
              role="listbox"
              aria-label="全局搜索结果"
              className="absolute right-0 top-[calc(100%+6px)] z-20 max-h-96 w-80 overflow-auto"
            >
              {!searchInput.trim() ? (
                <div role="status" className="p-3 text-ui leading-5 text-text-soft">
                  输入关键词，搜索 Workspace、项目、记录、Todo、文件和联系人
                </div>
              ) : searching ? (
                <div role="status" className="flex items-center gap-2 px-2 py-2 text-ui text-text-soft">
                  <LoaderCircle className="spin" size={14} />
                  搜索中...
                </div>
              ) : searchError ? (
                <div role="status" className="p-3 text-center text-ui text-danger">
                  搜索失败，请稍后重试
                </div>
              ) : searchResults.length > 0 ? (
                <div className="py-1" role="presentation">
                  {searchResults.map((result, index) => (
                    <button
                      key={[
                        result.kind,
                        result.kind === "todo" ? result.scope : "default",
                        result.projectId ?? "workspace",
                        result.id,
                      ].join("-")}
                      id={`workspace-search-result-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeSearchResultIndex}
                      className="w-full rounded-[var(--radius-6)] bg-transparent px-2 py-2 text-left hover:bg-bg-hover aria-selected:bg-bg-hover"
                      onPointerMove={() => setActiveSearchResultIndex(index)}
                      onClick={() => selectSearchResult(result)}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <p className="truncate text-body font-medium text-text">
                          {result.title || "Untitled"}
                        </p>
                        <StatusBadge tone="neutral">{getSearchKindLabel(result.kind)}</StatusBadge>
                      </div>
                      {(result.kind === "todo" ? result.source : result.subtitle) ? (
                        <p className="truncate text-ui text-text-soft">
                          {result.kind === "todo" ? result.source : result.subtitle}
                        </p>
                      ) : null}
                      {result.matchedText &&
                      result.matchedText !== result.title &&
                      result.matchedText !==
                        (result.kind === "todo" ? result.source : result.subtitle) ? (
                        <p className="mt-1 truncate text-ui text-text-muted">
                          {result.matchedText}
                        </p>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div role="status" className="p-3 text-center text-ui text-text-soft">
                  没有匹配结果
                </div>
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

function getSearchKindLabel(kind: WorkspaceSearchResult["kind"]) {
  switch (kind) {
    case "workspace_quick_note":
      return "Workspace 快速笔记";
    case "workspace_note":
      return "Workspace 记录";
    case "contact":
      return "联系人";
    case "project":
      return "项目";
    case "note":
      return "记录";
    case "todo":
      return "Todo";
    case "document":
      return "文件";
  }
}
