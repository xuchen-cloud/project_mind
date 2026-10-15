import { useTabIndicator } from "./useTabIndicator";
import { ProjectHomeIcon } from "../home/HomeCover";
import { useSearchResultsMotion } from "../../hooks/useSearchResultsMotion";
import {
  ArrowLeftRight,
  X,
  FolderKanban,
  ExternalLink,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Search,
  Settings,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
  useEffect,
  useLayoutEffect,
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
import { TabStripScroll } from "../../ui/components/TabStripScroll";
import "../../ui/tab-strip.css";
import { measureTabLabels } from "../../ui/tab-strip";

interface WorkspaceTopBarProps {
  homePanels?: { rightWidth?: number; leftWidth: number; workspaceName: string; leftOpen: boolean; rightOpen: boolean; toggleLeft: () => void; toggleRight: () => void };
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
  onSwitchWorkspace: () => void;
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
  homePanels,
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
  onSwitchWorkspace,
  onOpenSettings,
  onSearchSelect,
  onDetachProject,
}: WorkspaceTopBarProps) {
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const tabViewportRef = useRef<HTMLDivElement | null>(null);
  const [tabEdges, setTabEdges] = useState({ left: 0, right: 0 });
  const projectKey = projects.map(project => `${project.id}:${project.name}`).join("|");
  function measureTabs(labels = false) {
    const node = tabViewportRef.current;
    if (!node) return;
    const max = Math.max(0, node.scrollWidth - node.clientWidth);
    const position = Math.max(0, Math.min(max, node.scrollLeft));
    const distance = Math.min(64, max / 2);
    const next = { left: distance ? Math.min(1, position / distance) : 0, right: distance ? Math.min(1, (max - position) / distance) : 0 };
    setTabEdges(previous => previous.left === next.left && previous.right === next.right ? previous : next);
    if (labels) measureTabLabels(tabListRef.current);
  }
  useLayoutEffect(() => {
    const node = tabViewportRef.current;
    const reveal = () => {
      measureTabs(true);
      const selected = tabListRef.current?.querySelector<HTMLElement>("[data-selected]");
      if (!node || !selected) return;
      const bounds = node.getBoundingClientRect(), tab = selected.getBoundingClientRect();
      const delta = tab.left < bounds.left + 4 ? tab.left - bounds.left - 4
        : tab.right > bounds.right - 4 ? tab.right - bounds.right + 4 : 0;
      node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta));
      measureTabs();
    };
    reveal();
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(node);
    if (tabListRef.current) observer.observe(tabListRef.current);
    return () => observer.disconnect();
  }, [activeProjectId, workspaceActive, showWorkspace, projectKey]);
  useEffect(() => {
    const node = tabViewportRef.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * factor;
      const next = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta));
      if (next === node.scrollLeft) return;
      event.preventDefault(); node.scrollLeft = next; measureTabs();
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  const indicatorRef = useTabIndicator(tabListRef, `${workspaceActive}:${activeProjectId}:${projectKey}`);
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
                icon: ExternalLink,
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

    const searchMotionRef = useRef<HTMLDivElement>(null);
  useSearchResultsMotion(searchMotionRef, `${searchInput}:${searching}:${searchResults.map(result => `${result.kind}:${result.id}`).join(",")}`);
  return (
    <header data-tauri-drag-region style={homePanels?.leftOpen ? { "--home-navigation-width": `${homePanels.leftWidth}px` } as CSSProperties : undefined} data-home-left-open={homePanels?.leftOpen || undefined} data-home-right-open={homePanels?.rightOpen || undefined} className="workspace-topbar sticky top-0 z-20 flex h-10 items-center justify-between gap-4 border-b border-border bg-bg/95 px-3 backdrop-blur-sm">
      {homePanels ? <div data-tauri-drag-region className="workspace-topbar__navigation">
        <IconButton type="button" aria-label="切换左侧栏" aria-expanded={homePanels.leftOpen} onClick={homePanels.toggleLeft}><PanelLeft size={16} /></IconButton>
        {showWorkspace ? <button type="button" className="workspace-topbar__workspace-home"
          aria-label={`${homePanels.workspaceName} 工作区首页`} title={`${homePanels.workspaceName} · 工作区首页`}
          aria-current={workspaceActive ? "page" : undefined} onClick={onOpenWorkspace}>
          <FolderKanban size={14} aria-hidden="true" />{homePanels.leftOpen ? <span>{homePanels.workspaceName}</span> : null}
        </button> : null}
      </div> : null}
      <div data-tauri-drag-region className="workspace-topbar__tab-frame tab-strip-frame" style={{ "--tab-fade-left": tabEdges.left, "--tab-fade-right": tabEdges.right } as CSSProperties}>
        <div ref={tabViewportRef} id="project-tabs-scroll" className="workspace-topbar__tab-scroll tab-strip-viewport" onScroll={() => measureTabs()}>
        <div
          data-tauri-drag-region
          ref={tabListRef}
          className="workspace-topbar__tablist"
          role="tablist"
          aria-label={homePanels ? "项目" : "Workspace 与项目"}
        >
          <span ref={indicatorRef} className="workspace-topbar__indicator" aria-hidden="true" />
          {showWorkspace && !homePanels ? (
            <button
              type="button"
              className={[
                "workspace-topbar__tab workspace-topbar__tab--workspace compact-tab",
                workspaceActive ? "workspace-topbar__tab--active" : "",
              ].join(" ")}
              onClick={onOpenWorkspace}
              onKeyDown={(event) =>
                handleTabKeyDown(event, (tab) => tab.click())
              }
              role="tab"
              aria-selected={workspaceActive}
              data-selected={workspaceActive || undefined}
              tabIndex={workspaceActive || activeProjectId === null ? 0 : -1}
              aria-label="Workspace"
              title="Workspace"
            >
              <FolderKanban size={14} />

            </button>
          ) : null}
          {projects.map((project) => (
            <div
              key={project.id}
              className={[
                "workspace-topbar__tab compact-tab",
                project.id === activeProjectId ? "workspace-topbar__tab--active" : "",
                draggingProjectId === project.id ? "opacity-60" : "",
              ].join(" ")}
              onClick={() => onOpenProject(project.id)}
              onPointerDown={(event) => {
                  if (!dragEnabled || event.button !== 0 || (event.target instanceof Element && event.target.closest(".compact-tab__close"))) {
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
              role="presentation"
              data-selected={project.id === activeProjectId || undefined}
            >
              <div className="compact-tab__body">
              <button
                type="button"
                className="workspace-topbar__tab-trigger compact-tab__trigger"
                onKeyDown={(event) =>
                  handleTabKeyDown(event, (tab) => tab.click())
                }
                role="tab"
                aria-selected={project.id === activeProjectId}
                tabIndex={
                  project.id === activeProjectId ||
                  ((!showWorkspace || homePanels !== undefined) && (workspaceActive || activeProjectId === null) && project === projects[0])
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
                title={project.name}
              >
                <span className="workspace-topbar__tab-icon" aria-hidden="true"><ProjectHomeIcon rootPath={project.rootPath} size={14} /></span>
                <span className="workspace-topbar__tab-label compact-tab__label">{project.name}</span>
              </button>
              {onCloseProject ? (
                <button
                  type="button"
                  aria-label={`关闭 ${project.name}`}
                  className={[
                    "workspace-topbar__tab-close compact-tab__close",
                    project.id === activeProjectId ? "workspace-topbar__tab-close--persistent" : "",
                  ].join(" ")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseProject(project.id);
                  }}
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              ) : null}
              </div>
            </div>
          ))}
        </div>
        </div>
        <TabStripScroll viewportRef={tabViewportRef} contentKey={`${showWorkspace}:${projectKey}`} ariaLabel="项目标签滚动" viewportId="project-tabs-scroll" />
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
            placeholder="全局搜索"
            className="w-64"
            loading={searching}
          />

          {searchFocused ? (
            <PopoverPanel
              ref={searchMotionRef}
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

        {!homePanels ? <>
        <IconButton
          type="button"
          size="md"
          aria-label="切换 Workspace"
          title="切换 Workspace"
          onClick={onSwitchWorkspace}
        >
          <ArrowLeftRight size={14} />
        </IconButton>

        <IconButton
          type="button"
          size="md"
          aria-label="设置"
          className={settingsActive ? "text-accent" : undefined}
          onClick={onOpenSettings}
        >
          <Settings size={13} />
        </IconButton>
        </> : null}
      </div>

      {homePanels ? <IconButton type="button" aria-label="切换右侧栏" data-right-sidebar-toggle aria-expanded={homePanels.rightOpen} onClick={homePanels.toggleRight}><PanelRight size={16} /></IconButton> : null}
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
