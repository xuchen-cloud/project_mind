import {
  Archive,
  CalendarDays,
  CircleHelp,
  CircleUser,
  FolderKanban,
  LoaderCircle,
  Plus,
  Sparkles,
  Settings2,
} from "lucide-react";
import type { ProjectListItem, WorkspaceSearchResult } from "../../lib/types";
import {
  Button,
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
  askOpen?: boolean;
  showAsk?: boolean;
  settingsActive?: boolean;
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
  onOpenToday: () => void;
  onOpenAsk: () => void;
  onOpenSettings: () => void;
  onSearchSelect: (result: WorkspaceSearchResult) => void;
}

export function WorkspaceTopBar({
  projects,
  activeProjectId,
  todayActive = false,
  showToday = true,
  askOpen = false,
  showAsk = true,
  settingsActive = false,
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
  onOpenToday,
  onOpenAsk,
  onOpenSettings,
  onSearchSelect,
}: WorkspaceTopBarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-10 items-center justify-between gap-4 border-b border-border bg-bg/95 px-3 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-6)] bg-bg-subtle text-text-muted">
            <FolderKanban size={14} />
          </div>
          <span className="text-ui font-medium text-text-muted tracking-tight">
            Project Mind
          </span>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="Projects">
          {showToday ? (
            <button
              type="button"
              className={[
                "shrink-0 inline-flex items-center gap-1.5 rounded-[var(--radius-6)] px-2.5 h-8 text-ui font-medium transition-[background-color,color,border-color] duration-[160ms] ease-[var(--ease-soft)] border",
                todayActive
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                  : "text-text-muted border-transparent hover:text-text hover:bg-bg-hover",
              ].join(" ")}
              onClick={onOpenToday}
            >
              <CalendarDays size={14} />
              <span>Today</span>
            </button>
          ) : null}
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={[
                "shrink-0 rounded-[var(--radius-6)] px-2.5 h-8 text-ui font-medium transition-[background-color,color,border-color] duration-[160ms] ease-[var(--ease-soft)] border",
                project.id === activeProjectId
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                  : "text-text-muted border-transparent hover:text-text hover:bg-bg-hover",
              ].join(" ")}
              onClick={() => onOpenProject(project.id)}
            >
              {project.name}
            </button>
          ))}
          <Button type="button" size="sm" variant="ghost" leadingIcon={<Plus size={14} />} onClick={onCreateProject}>
            新建
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {showAsk ? (
          <Button
            type="button"
            size="sm"
            variant={askOpen ? "secondary" : "ghost"}
            leadingIcon={<Sparkles size={14} />}
            onClick={onOpenAsk}
          >
            Ask
          </Button>
        ) : null}

        <div className="relative">
          <SearchField
            value={searchInput}
            onChange={(e) => onSearchInput(e.target.value)}
            placeholder="搜索项目、活动、Todo、文件"
            className="w-64"
            loading={searching}
          />

          {searchInput.trim() ? (
            <PopoverPanel className="absolute right-0 top-[calc(100%+6px)] w-80 max-h-96 overflow-auto">
              {searching ? (
                <div className="flex items-center gap-2 px-2 py-2 text-ui text-text-soft">
                  <LoaderCircle className="spin" size={14} />
                  搜索中...
                </div>
              ) : searchGroups.length > 0 ? (
                searchGroups.map(([group, results]) => (
                  <div key={group} className="py-1">
                    <p className="px-2 py-1 text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                      {group}
                    </p>
                    {results.map((result) => (
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
                          {result.title || "Untitled"}
                        </p>
                        <p className="truncate text-ui text-text-soft">
                          {result.subtitle || result.matchedText}
                        </p>
                      </button>
                    ))}
                  </div>
                ))
              ) : (
                <div className="p-3 text-center text-ui text-text-soft">没有匹配结果</div>
              )}
            </PopoverPanel>
          ) : null}
        </div>

        <div className="relative">
          <IconButton type="button" size="md" onClick={onToggleArchive}>
            <Archive size={13} />
          </IconButton>
          {archiveOpen ? (
            <PopoverPanel className="absolute right-0 top-[calc(100%+6px)] w-64">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                  ARCHIVED
                </span>
                <Button type="button" size="sm" variant="ghost" onClick={onCloseArchive}>
                  关闭
                </Button>
              </div>
              {archivedProjects.length > 0 ? (
                archivedProjects.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between gap-2 border-t border-border py-2 first:border-t-0"
                  >
                    <button
                      type="button"
                      className="min-w-0 truncate bg-transparent text-left text-body font-medium text-text"
                      onClick={() => onOpenProject(project.id)}
                    >
                      {project.name}
                    </button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => onRestoreProject(project.id)}>
                      恢复
                    </Button>
                  </div>
                ))
              ) : (
                <p className="py-1 text-ui text-text-soft">暂无归档项目</p>
              )}
            </PopoverPanel>
          ) : null}
        </div>

        <IconButton type="button" size="md" aria-label="帮助">
          <CircleHelp size={13} />
        </IconButton>
        <IconButton
          type="button"
          size="md"
          aria-label="设置"
          className={settingsActive ? "text-accent" : undefined}
          onClick={onOpenSettings}
        >
          <Settings2 size={13} />
        </IconButton>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-bg text-text-muted transition-colors hover:border-border-strong hover:text-text"
        >
          <CircleUser size={14} />
        </button>
      </div>
    </header>
  );
}
