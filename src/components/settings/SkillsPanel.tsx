import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { getErrorMessage } from "../../lib/errors";
import { parseRouteId } from "../../lib/formatters";
import { queryKeys } from "../../lib/queryKeys";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { skillsApi, type SkillCatalog } from "../../services/skillsApi";
import { Button, SectionHeader } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "../home/home.css";
import "./skills.css";

export function SkillsPanel({ open }: { open: boolean }) {
  const params = useParams();
  const projectId = parseRouteId(params.projectId);
  const workspace = useQuery({
    queryKey: queryKeys.workspaceStatus,
    queryFn: projectMindApi.workspaceStatusGet,
    enabled: open,
  });
  const root = workspace.data?.currentWorkspace?.rootPath ?? null;

  if (!open) return null;
  if (workspace.isPending) return <p role="status">正在加载发现范围…</p>;
  if (workspace.isError) return <div role="alert">
    <p>{getErrorMessage(workspace.error, "加载工作区失败")}</p>
    <Button size="sm" variant="secondary" onClick={() => void workspace.refetch()}>重试</Button>
  </div>;

  return <SkillsScope key={JSON.stringify([root, projectId])} root={root} initialProjectId={projectId} workspaceRevision={workspace.dataUpdatedAt} />;
}

function SkillsScope({ root, initialProjectId, workspaceRevision }: { root: string | null; initialProjectId: number | null; workspaceRevision: number }) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [attempt, setAttempt] = useState(0);
  const projects = useQuery({
    queryKey: ["projects", "skills", root],
    queryFn: () => projectMindApi.projectsList(),
    enabled: root !== null,
  });
  const items = projects.data ?? [];

  return <div className="space-y-5">
    <SectionHeader title="Skills" description="查看当前范围发现的技能，打开技能文件或所在目录。"
      actions={<Button size="sm" variant="secondary" onClick={() => setAttempt(value => value + 1)}>刷新</Button>} />
    {root !== null ? <div className="space-y-2">
      <label className="flex flex-wrap items-center gap-3 text-body text-text-muted">
        发现范围
        <select aria-label="发现范围" value={projectId ?? ""}
          className="min-w-0 max-w-full rounded-[var(--radius-8)] border border-border bg-bg px-3 py-2 text-body text-text"
          onChange={event => setProjectId(event.target.value === "" ? null : Number(event.target.value))}>
          <option value="">工作区</option>
          {projectId !== null && !items.some(project => project.id === projectId)
            ? <option value={projectId}>当前项目 #{projectId}</option> : null}
          {items.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      {projects.isError ? <div role="alert" className="text-body text-text-muted">
        <p>{getErrorMessage(projects.error, "加载项目列表失败")}</p>
        <Button size="sm" variant="ghost" onClick={() => void projects.refetch()}>重试加载项目</Button>
      </div> : null}
    </div> : <p className="text-body text-text-muted">当前使用独立工作区的 Skills。</p>}
    <SkillsCatalog key={JSON.stringify([projectId, workspaceRevision, attempt])} projectId={projectId} />
  </div>;
}

function SkillsCatalog({ projectId }: { projectId: number | null }) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const generation = useRef(0);
  const openOperation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setCatalog(null);
    setError(null);
    setOpenError(null);
    void skillsApi.list(projectId).then(result => {
      if (generation.current === current) setCatalog(result);
    }, reason => {
      if (generation.current === current) setError(getErrorMessage(reason, "发现 Skills 失败"));
    });
    return () => { generation.current++; };
  }, [projectId, attempt]);

  async function openPath(path: string, folder: boolean) {
    const current = generation.current;
    const operation = ++openOperation.current;
    setOpenError(null);
    try {
      if (folder) await desktopApi.openFolder(path);
      else await desktopApi.openFile(path);
    } catch (reason) {
      if (generation.current === current && openOperation.current === operation) setOpenError(getErrorMessage(reason, "打开失败"));
    }
  }

  if (error) return <div role="alert" className="space-y-2 text-body text-text-muted">
    <p>{error}</p>
    <Button size="sm" variant="secondary" onClick={() => setAttempt(value => value + 1)}>重试</Button>
  </div>;
  if (!catalog) return <p role="status" className="text-body text-text-muted">正在发现 Skills…</p>;

  return <div className="space-y-4">
    <p role="status" className="text-body text-text-muted">
      {catalog.complete ? `已发现 ${catalog.skills.length} 个 Skills` : "发现尚未完成，当前列表可能不完整。可刷新重试。"}
    </p>
    {openError ? <p role="alert" className="text-body text-danger">{openError}</p> : null}
    {catalog.skills.length === 0 ? <p className="text-body text-text-muted">未发现 Skills。</p> : <div className="skills-scroll"><HomeSidebarList label="Skills 列表"><ul className="divide-y divide-border">
      {catalog.skills.map((skill, index) => <li key={`${skill.source}:${skill.path}:${skill.name}:${index}`} className="space-y-2 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-body font-medium text-text">{skill.name}</h3>
            <p className="break-words text-body text-text-muted">{skill.description}</p>
          </div>
          {skill.path !== null ? <Button size="sm" variant="ghost" className="shrink-0" aria-label={`打开 ${skill.name}`} onClick={() => { if (skill.path !== null) void openPath(skill.path, false); }}>打开文件</Button> : null}
        </div>
        <p className="break-all text-caption text-text-muted">来源：<span>{skillSourceLabel(skill.source)}</span></p>
        {skill.path !== null ? <p className="break-all text-caption text-text-soft">{skill.path}</p> : null}
      </li>)}
    </ul></HomeSidebarList></div>}
    {catalog.directories.length > 0 ? <div className="space-y-2">
      <h3 className="text-body font-medium text-text">技能目录</h3>
      <div className="skills-scroll skills-scroll--directories"><HomeSidebarList label="技能目录"><ul className="space-y-2">{catalog.directories.map(path => <li key={path} className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-all text-body text-text-muted">{path}</span>
        <Button size="sm" variant="ghost" className="shrink-0" aria-label={`打开目录 ${path}`} onClick={() => void openPath(path, true)}>打开目录</Button>
      </li>)}</ul></HomeSidebarList></div>
    </div> : null}
  </div>;
}

function skillSourceLabel(source: string): string {
  switch (source) {
    case "bundled": return "内置";
    case "project-dsh":
    case "project-agents": return "项目";
    case "user-dsh":
    case "user-agents": return "用户";
    case "runtime": return "运行时";
    default: return source;
  }
}
