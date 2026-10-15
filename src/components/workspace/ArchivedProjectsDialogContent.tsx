import { useEffect, useState } from "react";

import type { ProjectListItem } from "../../lib/types";
import { Button, Dialog, SearchField } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";

export interface ArchivedProjectsDialogProps {
  open: boolean;
  projects: ProjectListItem[];
  onClose: () => void;
  onOpenProject: (id: number) => void;
  onRestoreProject: (id: number) => void;
}

export function ArchivedProjectsDialogContent({
  open,
  projects,
  onClose,
  onOpenProject,
  onRestoreProject,
}: ArchivedProjectsDialogProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(normalizedQuery)
    || project.rootPath.toLowerCase().includes(normalizedQuery),
  );

  return (
    <Dialog
      open={open}
      title="归档项目"
      widthClassName="max-w-2xl h-[min(72dvh,42rem)]"
      bodyClassName="flex min-h-0 flex-col gap-3 overflow-hidden overflow-y-hidden"
      onClose={onClose}
    >
      <div className="flex shrink-0 items-center gap-2">
        <SearchField
          type="search"
          className="min-w-0 flex-1"
          aria-label="搜索归档项目"
          placeholder="搜索名称或路径"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => setQuery("")}>
            清空搜索
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden [--home-sidebar:var(--color-bg)]">
        <HomeSidebarList label="归档项目列表" searchKey={normalizedQuery}>
          <div className="space-y-3">
            {filteredProjects.length > 0 ? (
              filteredProjects.map((project) => (
                <section
                  key={project.id}
                  className="rounded-[var(--radius-10)] border border-border bg-[color-mix(in_srgb,var(--color-bg-subtle)_70%,var(--color-bg))] px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <h3 className="min-w-0 truncate text-body font-medium text-text" title={project.name}>
                          {project.name}
                        </h3>
                      </div>
                      <p className="mt-1 truncate text-ui text-text-soft" title={project.rootPath}>{project.rootPath}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          onClose();
                          onOpenProject(project.id);
                        }}
                      >
                        打开
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => onRestoreProject(project.id)}>
                        恢复
                      </Button>
                    </div>
                  </div>
                </section>
              ))
            ) : (
              <div className="rounded-[var(--radius-10)] border border-dashed border-border px-4 py-8 text-center">
                <p className="text-body font-medium text-text">
                  {projects.length === 0 ? "暂无归档项目" : "没有匹配的归档项目"}
                </p>
              </div>
            )}
          </div>
        </HomeSidebarList>
      </div>
    </Dialog>
  );
}
