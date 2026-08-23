import { FolderOpen, Plus } from "lucide-react";

import type { WorkspaceSummary } from "../../lib/types";
import { Button } from "../../ui/components";

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
        <p className="flex items-center gap-2 text-body text-text-secondary">
          <span className="spin h-3.5 w-3.5 rounded-full border border-border-strong border-t-accent" />
          正在检查最近使用的 Workspace…
        </p>
      </div>
    );
  }

  return (
    <div className="workspace-gate-shell flex min-h-dvh items-center justify-center px-6 py-10">
      <main className="workspace-gate grid w-full max-w-5xl overflow-hidden rounded-[var(--radius-12)] border border-border bg-bg lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <section className="grid content-center gap-7 px-8 py-10 sm:px-12 sm:py-14">
          <div className="grid max-w-2xl gap-3">
            <p className="text-caption font-semibold uppercase tracking-[0.16em] text-text-tertiary">
              Project Mind
            </p>
            <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.03em] text-text">
              打开你的 Workspace
            </h1>
            <p className="max-w-xl text-body leading-7 text-text-secondary">
              从一个本地 Workspace 继续项目、Record 和 Todo。数据与设置保持在同一目录中。
            </p>
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
              leadingIcon={<Plus size={16} />}
              onClick={onCreateWorkspace}
            >
              新建 Workspace
            </Button>
          </div>

          <p className="text-ui leading-6 text-text-tertiary">
            数据只保存在你选择的本地目录，不会自动上传。
          </p>
        </section>

        <aside className="border-t border-border bg-bg-subtle px-6 py-8 lg:border-l lg:border-t-0">
          <div className="mb-5">
            <p className="text-caption font-semibold uppercase tracking-[0.16em] text-text-tertiary">
              Recent
            </p>
            <h2 className="mt-1 text-title font-semibold text-text">
              最近使用
            </h2>
          </div>

          {recentWorkspaces.length > 0 ? (
            <div className="divide-y divide-border border-y border-border">
              {recentWorkspaces.map((workspace) => (
                <button
                  key={workspace.rootPath}
                  type="button"
                  className="grid w-full gap-0.5 px-1 py-3 text-left transition-colors duration-[var(--duration-standard)] hover:bg-bg-hover"
                  onClick={() => onOpenRecent(workspace.rootPath)}
                >
                  <p className="truncate text-body font-medium text-text">
                    {workspace.displayName}
                  </p>
                  <p className="break-all text-ui leading-6 text-text-tertiary">
                    {workspace.rootPath}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <p className="border-t border-border py-4 text-body leading-6 text-text-secondary">
              还没有最近使用的 Workspace。
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}
