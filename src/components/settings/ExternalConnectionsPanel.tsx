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

const WRITE_PERMISSION_OPTIONS = [
  { value: "content.create", label: "创建 Record 和待办" },
  { value: "record.patch", label: "修改 Record 正文块" },
  { value: "record.restore", label: "恢复 Record 历史版本" },
  { value: "todo.update", label: "修改待办（包括子行动）" },
  { value: "operation.undo", label: "撤销此连接自己的更改" },
] as const;

function grantPermissions(operations: string[]) {
  const writeOperations = operations.filter((operation) => !/\.(?:read|get|list|search)$/u.test(operation));
  if (writeOperations.length === 0) return "只读";
  const labels = writeOperations.map((operation) =>
    operation === "operation.restore_created"
      ? "撤销此连接自己的更改"
      : WRITE_PERMISSION_OPTIONS.find((option) => option.value === operation)?.label ?? "其他写入权限",
  );
  return `可读取和修改：${[...new Set(labels)].join("、")}`;
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
  const [writeOperations, setWriteOperations] = useState<string[]>([]);
  const epoch = useRef(0);
  const loadedWorkspace = useRef<string | null>(null);

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
      const nextWorkspace = nextStatus.binding
        ? `${nextStatus.binding.workspaceId}:${nextStatus.binding.generation}`
        : "closed";
      if (loadedWorkspace.current !== nextWorkspace) {
        setWorkspaceContent(false);
        setSessionRead(false);
        setWriteOperations([]);
        loadedWorkspace.current = nextWorkspace;
      }
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
      <SectionHeader title="外部连接" description="允许本机工具访问你选择的内容；写入权限需另行选择。" />
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
          <h3 className="text-body font-medium text-text">创建连接</h3>
          <label className="grid gap-1 text-ui text-text-secondary">连接名称<TextField value={clientLabel} onChange={(event) => setClientLabel(event.target.value)} placeholder="例如：终端助手" /></label>
          <label className="grid gap-1 text-ui text-text-secondary">授权的 Project
            <select className={`${settingsSelectClassName} min-w-0 max-w-full`} value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">不授权 Project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={workspaceContent} onChange={(event) => setWorkspaceContent(event.target.checked)} />另外授权 Workspace 内容</label>
          <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={sessionRead} onChange={(event) => setSessionRead(event.target.checked)} />允许读取会话依据</label>
          <details className="text-ui text-text-secondary">
            <summary className="cursor-pointer">允许写入（可选）</summary>
            <p className="mt-2">默认只读；所选写入权限仅作用于上方授权范围。</p>
            <div className="mt-2 grid gap-2">
              {WRITE_PERMISSION_OPTIONS.map((option) => <label key={option.value} className="flex items-center gap-2">
                <input type="checkbox" checked={writeOperations.includes(option.value)} onChange={(event) => setWriteOperations((current) => event.target.checked ? [...current, option.value] : current.filter((value) => value !== option.value))} />
                {option.label}
              </label>)}
            </div>
          </details>
          <div><Button size="sm" disabled={busy || (projectId === null && !workspaceContent) || !clientLabel.trim()} onClick={() => void run(() => externalConnectionsApi.create(binding, { clientLabel: clientLabel.trim(), projectIds: projectId === null ? [] : [projectId], workspaceContent, sessionRead, writeOperations }))}>创建连接</Button></div>
        </div>}
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 border-t border-border pt-4">
          <h3 className="text-body font-medium text-text">已有连接</h3>
          {grants.length === 0 && <p className="text-ui text-text-secondary">暂无连接。</p>}
          {grants.map((grant) => {
            const canCopy = grant.enabled && !grant.revokedAt && !!status.cliPath && !!status.workspacePath;
            const command = canCopy && status.cliPath && status.workspacePath
              ? `${status.cliShell === "powershell" ? "& " : ""}${shellQuote(status.cliPath, status.cliShell)} doctor --workspace ${shellQuote(status.workspacePath, status.cliShell)} --connection ${shellQuote(grant.id, status.cliShell)} --json`
              : null;
            const mcpConfig = canCopy ? JSON.stringify({
              mcpServers: { projectmind: {
                command: status.cliPath,
                args: ["mcp", "serve", "--workspace", status.workspacePath, "--connection", grant.id],
              } },
            }, null, 2) : null;
            return <div key={grant.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 border-b border-border pb-3 text-ui">
              <div className="flex items-center gap-2"><strong className="text-text">{grant.clientLabel}</strong><StatusBadge tone={grant.enabled && !grant.revokedAt ? "success" : "neutral"}>{grant.revokedAt ? "已撤销" : grant.enabled ? "有效" : "已停用"}</StatusBadge></div>
              <p className="break-words text-text-secondary">{grant.workspaceContent ? "Workspace 内容；" : ""}Project：{grant.projectIds.map((id) => projectNames[id] ?? "已移除的项目").join("、") || "无"}；{grantPermissions(grant.operations)}{grant.operations.includes("session.read") ? "，包含会话依据" : ""}</p>
              <div className="flex flex-wrap gap-2">
                {command && <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(command).catch((reason: unknown) => setError(String(reason)))}>复制 CLI 命令</Button>}
                {mcpConfig && <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(mcpConfig).catch((reason: unknown) => setError(String(reason)))}>复制 MCP 配置</Button>}
                {!grant.revokedAt && binding && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => externalConnectionsApi.revoke(binding, grant.id), true)}>撤销</Button>}
              </div>
              {mcpConfig && <p className="text-text-secondary">MCP 权限与此连接的授权一致。</p>}
            </div>;
          })}
        </div>
      </>}
    </div>
  );
}
