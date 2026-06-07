import {
  Archive,
  CalendarDays,
  CircleX,
  CircleHelp,
  CircleUser,
  FolderOpen,
  Lock,
  LoaderCircle,
  Plus,
  RefreshCcw,
  Settings2,
  Sparkles,
} from "lucide-react";

import type {
  ProjectListItem,
  WorkspaceSearchResult,
  WorkspaceSummary,
} from "../../lib/types";
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
  currentWorkspace?: WorkspaceSummary | null;
  aiSecretsUnlocked: boolean;
  archivedProjects: ProjectListItem[];
  searchInput: string;
  onSearchInput: (value: string) => void;
  searchResults: WorkspaceSearchResult[];
  searching: boolean;
  archiveOpen: boolean;
  onToggleArchive: () => void;
  onCloseArchive: () => void;
  onOpenProject: (projectId: number) => void;
  onCloseProject?: (projectId: number) => void;
  onRestoreProject: (projectId: number) => void;
  workspaceMenuOpen: boolean;
  onToggleWorkspaceMenu: () => void;
  onCloseWorkspaceMenu: () => void;
  onOpenWorkspaceFolder: () => void;
  onSwitchWorkspace: () => void;
  onLockAiSecrets: () => void;
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
  currentWorkspace,
  aiSecretsUnlocked,
  archivedProjects,
  searchInput,
  onSearchInput,
  searchResults,
  searching,
  archiveOpen,
  onToggleArchive,
  onCloseArchive,
  onOpenProject,
  onCloseProject,
  onRestoreProject,
  workspaceMenuOpen,
  onToggleWorkspaceMenu,
  onCloseWorkspaceMenu,
  onOpenWorkspaceFolder,
  onSwitchWorkspace,
  onLockAiSecrets,
  onCreateProject,
  onOpenToday,
  onOpenAsk,
  onOpenSettings,
  onSearchSelect,
}: WorkspaceTopBarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-10 items-center justify-between gap-4 border-b border-border bg-bg/95 px-3 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="Projects">
          {showToday ? (
            <button
              type="button"
              className={[
                "shrink-0 inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-6)] border px-2.5 text-ui font-medium transition-[background-color,color,border-color] duration-[160ms] ease-[var(--ease-soft)]",
                todayActive
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                  : "border-transparent text-text-muted hover:bg-bg-hover hover:text-text",
              ].join(" ")}
              onClick={onOpenToday}
            >
              <CalendarDays size={14} />
              <span>总览</span>
            </button>
          ) : null}
          {projects.map((project) => (
            <div
              key={project.id}
              className={[
                "group shrink-0 inline-flex h-8 items-center rounded-[var(--radius-6)] border pr-1 text-ui font-medium transition-[background-color,color,border-color] duration-[160ms] ease-[var(--ease-soft)]",
                project.id === activeProjectId
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                  : "border-transparent text-text-muted hover:bg-bg-hover hover:text-text",
              ].join(" ")}
              role="presentation"
            >
              <button
                type="button"
                className="h-full min-w-0 rounded-[var(--radius-6)] px-2.5"
                onClick={() => onOpenProject(project.id)}
              >
                <span className="truncate">{project.name}</span>
              </button>
              {onCloseProject ? (
                <button
                  type="button"
                  aria-label={`关闭 ${project.name}`}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-6)] text-current opacity-55 transition-[background-color,opacity] hover:bg-bg/80 hover:opacity-100"
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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            leadingIcon={<Plus size={14} />}
            onClick={onCreateProject}
          >
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

        <div className="relative">
          <IconButton type="button" size="md" onClick={onToggleArchive}>
            <Archive size={13} />
          </IconButton>
          {archiveOpen ? (
            <PopoverPanel className="absolute right-0 top-[calc(100%+6px)] z-20 w-64">
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
        <div className="relative">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-bg text-text-muted transition-colors hover:border-border-strong hover:text-text"
            onClick={onToggleWorkspaceMenu}
          >
            <CircleUser size={14} />
          </button>
          {workspaceMenuOpen ? (
            <PopoverPanel className="absolute right-0 top-[calc(100%+6px)] z-20 w-72">
              <div className="mb-3">
                <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                  Workspace
                </p>
                <p className="mt-2 text-body font-medium text-text">
                  {currentWorkspace?.displayName ?? "Current Workspace"}
                </p>
                <p className="mt-1 break-all text-ui text-text-soft">
                  {currentWorkspace?.rootPath ?? "未提供路径"}
                </p>
              </div>

              <div className="grid gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  leadingIcon={<FolderOpen size={14} />}
                  onClick={() => {
                    onCloseWorkspaceMenu();
                    onOpenWorkspaceFolder();
                  }}
                >
                  打开 Workspace
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  leadingIcon={<RefreshCcw size={14} />}
                  onClick={() => {
                    onCloseWorkspaceMenu();
                    onSwitchWorkspace();
                  }}
                >
                  切换 Workspace
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  leadingIcon={<Lock size={14} />}
                  disabled={!aiSecretsUnlocked}
                  onClick={() => {
                    onCloseWorkspaceMenu();
                    onLockAiSecrets();
                  }}
                >
                  {aiSecretsUnlocked ? "锁定 AI Secrets" : "AI Secrets 已锁定"}
                </Button>
              </div>
            </PopoverPanel>
          ) : null}
        </div>
      </div>
    </header>
  );
}
