import { FolderKanban, FolderOpen, ShieldEllipsis, Sparkles } from "lucide-react";

import type { WorkspaceSummary } from "../../lib/types";
import { Button, EmptyState, SurfaceCard } from "../../ui/components";

interface WorkspaceGatePageProps {
  loading: boolean;
  recentWorkspaces: WorkspaceSummary[];
  onOpenExisting: () => void;
  onCreateWorkspace: () => void;
  onOpenRecent: (rootPath: string) => void;
}

export function WorkspaceGatePage({
  loading,
  recentWorkspaces,
  onOpenExisting,
  onCreateWorkspace,
  onOpenRecent,
}: WorkspaceGatePageProps) {
  if (loading) {
    return (
      <div className="workspace-gate-shell flex h-dvh items-center justify-center px-6">
        <SurfaceCard className="w-full max-w-xl p-8 text-center">
          <p className="text-body text-text-soft">
            正在检查最近使用的 workspace...
          </p>
        </SurfaceCard>
      </div>
    );
  }

  return (
    <div className="workspace-gate-shell flex min-h-dvh items-center justify-center px-6 py-10">
      <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.9fr)]">
        <SurfaceCard className="grid gap-6 p-8">
          <div className="grid gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-[1.1rem] bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))] text-accent">
              <FolderKanban size={24} />
            </div>
            <div className="grid gap-2">
              <p className="text-caption font-medium uppercase tracking-[0.18em] text-text-soft">
                Workspace First
              </p>
              <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.03em] text-text">
                先打开一个 Workspace，再继续整理项目。
              </h1>
              <p className="max-w-2xl text-body leading-7 text-text-soft">
                所有项目、数据库、AI 缓存、日志和设置都会存放在同一个 workspace
                里的
                <code className="mx-1 rounded bg-bg-subtle px-1.5 py-0.5 text-ui">
                  .project-mind
                </code>
                隐藏目录中。复制整个 workspace
                后，另一台电脑也可以直接继续使用。
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="primary"
              size="md"
              leadingIcon={<FolderOpen size={16} />}
              onClick={onOpenExisting}
            >
              打开已有 Workspace
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="md"
              leadingIcon={<Sparkles size={16} />}
              onClick={onCreateWorkspace}
            >
              新建 Workspace
            </Button>
          </div>

          <div className="grid gap-3 rounded-[var(--radius-8)] border border-dashed border-border bg-bg-subtle/80 p-4">
            <p className="text-ui font-medium text-text">
              旧版本本地数据已清理
            </p>
            <p className="text-ui leading-6 text-text-soft">
              当前版本不再读取系统 app data
              中的历史业务库。后续请直接打开或创建新的 workspace。
            </p>
          </div>
        </SurfaceCard>

        <SurfaceCard className="grid gap-4 p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-caption font-medium uppercase tracking-[0.18em] text-text-soft">
                Recent
              </p>
              <h2 className="mt-1 text-title font-semibold text-text">
                最近使用的 Workspace
              </h2>
            </div>
            <ShieldEllipsis size={18} className="text-text-soft" />
          </div>

          {recentWorkspaces.length > 0 ? (
            <div className="grid gap-2">
              {recentWorkspaces.map((workspace) => (
                <button
                  key={workspace.rootPath}
                  type="button"
                  className="grid gap-1 rounded-[var(--radius-8)] border border-border bg-bg px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-bg-hover"
                  onClick={() => onOpenRecent(workspace.rootPath)}
                >
                  <p className="truncate text-body font-medium text-text">
                    {workspace.displayName}
                  </p>
                  <p className="break-all text-ui leading-6 text-text-soft">
                    {workspace.rootPath}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              title="还没有最近记录"
              text="先创建一个 workspace，或者打开一个已有目录。"
              icon={<FolderOpen size={16} />}
              className="min-h-40"
            />
          )}
        </SurfaceCard>
      </div>
    </div>
  );
}
