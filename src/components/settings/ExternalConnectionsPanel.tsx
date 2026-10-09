import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ProjectListItem } from "../../lib/types";
import type { ExternalConnectionsStatus } from "../../lib/external-connections-types";
import { queryKeys } from "../../lib/queryKeys";
import { externalConnectionsApi } from "../../services/externalConnectionsApi";
import { projectMindApi } from "../../services/projectMindApi";
import { Button, SectionHeader, StatusBadge, TextField } from "../../ui/components";
import { settingsSelectClassName } from "./shared";

function shellQuote(value: string, shell: ExternalConnectionsStatus["cliShell"]) {
  return shell === "powershell"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function ExternalConnectionsPanel({ open }: { open: boolean }) {
  const workspaceQuery = useQuery({
    queryKey: queryKeys.workspaceStatus,
    queryFn: projectMindApi.workspaceStatusGet,
    enabled: open,
  });
  const workspacePath = workspaceQuery.data?.currentWorkspace?.rootPath ?? null;
  const [status, setStatus] = useState<ExternalConnectionsStatus | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectNames, setProjectNames] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientLabel, setClientLabel] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [workspaceContent, setWorkspaceContent] = useState(false);
  const [sessionRead, setSessionRead] = useState(false);
  const epoch = useRef(0);

  useEffect(() => {
    const generation = ++epoch.current;
    if (!open || workspaceQuery.isPending) return;
    setStatus(null);
    setProjects([]);
    setProjectNames({});
    setProjectId(null);
    setBusy(false);
    setLoading(true);
    setError(null);
    void Promise.all([
      externalConnectionsApi.status(),
      workspacePath ? projectMindApi.projectsList({ includeArchived: true }) : Promise.resolve([]),
    ]).then(([nextStatus, nextProjects]) => {
      if (epoch.current !== generation) return;
      setStatus(nextStatus);
      const active = nextProjects.filter((project) => !project.isArchived);
      setProjectNames(Object.fromEntries(nextProjects.map((project) => [project.id, project.name])));
      setProjects(active);
      setProjectId(active[0]?.id ?? null);
    }).catch((reason: unknown) => {
      if (epoch.current === generation) setError(String(reason));
    }).finally(() => {
      if (epoch.current === generation) setLoading(false);
    });
    return () => { epoch.current++; };
  }, [open, workspacePath, workspaceQuery.isPending, workspaceQuery.dataUpdatedAt]);

  async function run(action: () => Promise<ExternalConnectionsStatus | unknown>, refreshOnError = false) {
    const generation = epoch.current;
    setBusy(true);
    setError(null);
    let failure: unknown = null;
    try {
      await action();
    } catch (reason) {
      failure = reason;
    }
    if (!failure || refreshOnError) {
      try {
        const next = await externalConnectionsApi.status();
        if (epoch.current === generation) setStatus(next);
      } catch (reason) {
        failure = failure ? `${String(failure)}；刷新连接状态失败：${String(reason)}` : reason;
      }
    }
    if (epoch.current === generation) {
      if (failure) setError(String(failure));
      setBusy(false);
    }
  }

  const binding = status?.binding ?? null;
  const grants = status?.connections ?? [];

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5" data-testid="external-connections-panel">
      <SectionHeader title="外部连接" description="允许本机工具读取你选择的项目内容。" />
      {loading && <p role="status" className="text-ui text-text-secondary">正在读取连接状态…</p>}
      {error && <p role="alert" className="text-ui text-danger">{error}</p>}
      {status && <>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => externalConnectionsApi.enable(!status.enabled))}>
            {status.enabled ? "停用本机连接" : "启用本机连接"}
          </Button>
          <StatusBadge tone={status.running ? "success" : "neutral"}>{status.running ? "服务运行中" : "服务未运行"}</StatusBadge>
          <span className="min-w-0 break-all text-ui text-text-secondary">{status.cliPath ? `CLI：${status.cliPath}` : "CLI 未安装"}</span>
        </div>
        {!binding && <p className="text-ui text-text-secondary">打开 Workspace 后才能创建连接。</p>}
        {binding && <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 border-t border-border pt-4">
          <h3 className="text-body font-medium text-text">创建只读连接</h3>
          <label className="grid gap-1 text-ui text-text-secondary">连接名称<TextField value={clientLabel} onChange={(event) => setClientLabel(event.target.value)} placeholder="例如：终端助手" /></label>
          <label className="grid gap-1 text-ui text-text-secondary">允许读取的 Project
            <select className={`${settingsSelectClassName} min-w-0 max-w-full`} value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">不授权 Project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={workspaceContent} onChange={(event) => setWorkspaceContent(event.target.checked)} />另外允许读取 Workspace 内容</label>
          <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={sessionRead} onChange={(event) => setSessionRead(event.target.checked)} />允许读取会话依据</label>
          <div><Button size="sm" disabled={busy || (projectId === null && !workspaceContent) || !clientLabel.trim()} onClick={() => void run(() => externalConnectionsApi.create(binding, { clientLabel: clientLabel.trim(), projectIds: projectId === null ? [] : [projectId], workspaceContent, sessionRead }))}>创建连接</Button></div>
        </div>}
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 border-t border-border pt-4">
          <h3 className="text-body font-medium text-text">已有连接</h3>
          {grants.length === 0 && <p className="text-ui text-text-secondary">暂无连接。</p>}
          {grants.map((grant) => {
            const command = status.cliPath && status.workspacePath
              ? `${status.cliShell === "powershell" ? "& " : ""}${shellQuote(status.cliPath, status.cliShell)} doctor --workspace ${shellQuote(status.workspacePath, status.cliShell)} --connection ${shellQuote(grant.id, status.cliShell)} --json`
              : null;
            return <div key={grant.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 border-b border-border pb-3 text-ui">
              <div className="flex items-center gap-2"><strong className="text-text">{grant.clientLabel}</strong><StatusBadge tone={grant.enabled && !grant.revokedAt ? "success" : "neutral"}>{grant.revokedAt ? "已撤销" : grant.enabled ? "有效" : "已停用"}</StatusBadge></div>
              <p className="break-words text-text-secondary">{grant.workspaceContent ? "Workspace 内容；" : ""}Project：{grant.projectIds.map((id) => projectNames[id] ?? "已移除的项目").join("、") || "无"}；只读{grant.operations.includes("session.read") ? "，包含会话依据" : ""}</p>
              <div className="flex gap-2">
                {command && <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(command).catch((reason: unknown) => setError(String(reason)))}>复制 CLI 命令</Button>}
                {!grant.revokedAt && binding && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => externalConnectionsApi.revoke(binding, grant.id), true)}>撤销</Button>}
              </div>
            </div>;
          })}
        </div>
      </>}
    </div>
  );
}
