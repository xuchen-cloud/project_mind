import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ProjectListItem } from "../../lib/types";
import type { ExternalConnectionsStatus } from "../../lib/external-connections-types";
import { queryKeys } from "../../lib/queryKeys";
import { externalConnectionsApi } from "../../services/externalConnectionsApi";
import { projectMindApi } from "../../services/projectMindApi";
import { Button, SectionHeader, StatusBadge, TextField } from "../../ui/components";
import "../home/home.css";
import { CliInstallation } from "./CliInstallation";
import { settingsSelectClassName } from "./shared";

type ConnectionScope = "workspace" | "project";
type ConnectionMode = "collaborate" | "read_only";
const COLLABORATE_OPERATIONS = ["content.create", "record.patch", "record.restore", "todo.update", "file.update", "file.restore", "operation.undo"];
function shellQuote(value: string, shell: ExternalConnectionsStatus["cliShell"]) {
  // PowerShell recognizes typographic apostrophes as quote delimiters too.
  return shell === "powershell"
    ? `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

const WRITE_PERMISSION_OPTIONS = [
  { value: "schedule.manage", label: "管理定时任务（可让 AI 操作整个工作区）" },
  { value: "content.create", label: "创建 Record、待办和文件" },
  { value: "record.patch", label: "修改 Record 正文块" },
  { value: "record.restore", label: "恢复 Record 历史版本" },
  { value: "todo.update", label: "修改待办（包括子行动）" },
  { value: "file.update", label: "修改文件内容" },
  { value: "file.restore", label: "恢复文件历史版本" },
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
  const [connectionScope, setConnectionScope] = useState<ConnectionScope>("workspace");
  const [scheduleManagement, setScheduleManagement] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("collaborate");
  const epoch = useRef(0);
  const loadedWorkspace = useRef<string | null>(null);

  useEffect(() => {
    const generation = ++epoch.current;
    if (!open || workspaceQuery.isPending) return;
    setStatus(null);
    setProjects([]);
    setProjectNames({});
    setBusy(false);
    setLoading(true);
    setError(null);
    void Promise.allSettled([
      externalConnectionsApi.status(),
      workspacePath ? projectMindApi.projectsList({ includeArchived: true }) : Promise.resolve([]),
    ]).then(([statusResult, projectsResult]) => {
      if (epoch.current !== generation) return;
      if (statusResult.status === "rejected") {
        setError(String(statusResult.reason));
        return;
      }
      const nextStatus = statusResult.value;
      const nextProjects = projectsResult.status === "fulfilled" ? projectsResult.value : [];
      if (projectsResult.status === "rejected") setError(String(projectsResult.reason));
      const nextWorkspace = nextStatus.binding
        ? `${nextStatus.binding.workspaceId}:${nextStatus.binding.generation}`
        : "closed";
      const changedWorkspace = loadedWorkspace.current !== nextWorkspace;
      if (changedWorkspace) {
        setConnectionScope("workspace");
        setConnectionMode("collaborate");
        setScheduleManagement(false);
        setProjectId(nextProjects.find((project) => !project.isArchived)?.id ?? null);
        loadedWorkspace.current = nextWorkspace;
      }
      setStatus(nextStatus);
      const active = nextProjects.filter((project) => !project.isArchived);
      setProjectNames(Object.fromEntries(nextProjects.map((project) => [project.id, project.name])));
      setProjects(active);
      if (!changedWorkspace) {
        setProjectId((current) => active.some((project) => project.id === current) ? current : active[0]?.id ?? null);
        if (active.length === 0) setConnectionScope("workspace");
      }
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
  const selectedProjectIds = connectionScope === "project" && projectId !== null ? [projectId] : [];
  const selectedWriteOperations = [...(connectionMode === "collaborate" ? COLLABORATE_OPERATIONS : []), ...(connectionScope === "workspace" && connectionMode === "collaborate" && scheduleManagement ? ["schedule.manage"] : [])];

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5" data-testid="external-connections-panel">
      <SectionHeader title="外部连接" description="为每个连接选择访问范围和权限。" />
      {loading && <p role="status" className="text-ui text-text-secondary">正在读取连接状态…</p>}
      {error && <p role="alert" className="text-ui text-danger">{error}</p>}
      {status && <>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => externalConnectionsApi.enable(!status.enabled))}>
            {status.enabled ? "停用本机连接" : "启用本机连接"}
          </Button>
          <StatusBadge tone={status.running ? "success" : "neutral"}>{status.running ? "服务运行中" : "服务未运行"}</StatusBadge>
        </div>
        <CliInstallation
          installation={status.cliInstallation}
          busy={busy}
          onInstall={() => void run(() => externalConnectionsApi.installCli(), true)}
          onUninstall={() => void run(() => externalConnectionsApi.uninstallCli(), true)}
        />
        {!binding && <p className="text-ui text-text-secondary">打开 Workspace 后才能创建连接。</p>}
        {binding && <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 border-t border-border pt-4">
          <h3 className="text-body font-medium text-text">创建连接</h3>
          <label className="grid gap-1 text-ui text-text-secondary">连接名称<TextField value={clientLabel} onChange={(event) => setClientLabel(event.target.value)} placeholder="例如：终端助手" /></label>
          <fieldset className="grid gap-1.5 text-ui text-text-secondary">
            <legend className="mb-1">授权范围</legend>
            <label className="flex items-center gap-2"><input type="radio" name="connection-scope" checked={connectionScope === "workspace"} onChange={() => setConnectionScope("workspace")} />Workspace（包含所有未归档 Project）</label>
            <label className="flex items-center gap-2"><input type="radio" name="connection-scope" checked={connectionScope === "project"} disabled={projects.length === 0} onChange={() => setConnectionScope("project")} />单个 Project</label>
          </fieldset>
          {connectionScope === "project" && <label className="grid gap-1 text-ui text-text-secondary">授权的 Project
            <select className={`${settingsSelectClassName} min-w-0 max-w-full`} value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value ? Number(event.target.value) : null)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>}
          <fieldset className="grid gap-1.5 text-ui text-text-secondary">
            <legend className="mb-1">权限</legend>
            <label className="flex items-center gap-2"><input type="radio" name="connection-mode" checked={connectionMode === "collaborate"} onChange={() => setConnectionMode("collaborate")} />协作（推荐）</label>
            <label className="flex items-center gap-2"><input type="radio" name="connection-mode" checked={connectionMode === "read_only"} onChange={() => setConnectionMode("read_only")} />只读</label>
          </fieldset>
          <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={connectionScope === "workspace" && connectionMode === "collaborate" && scheduleManagement} disabled={connectionScope !== "workspace" || connectionMode !== "collaborate"} onChange={event => setScheduleManagement(event.target.checked)} />管理定时任务（可让 AI 操作整个工作区）</label>
          <p className="text-ui text-text-secondary">
            {connectionScope === "workspace" ? "Workspace 直属内容和所有未归档 Project，新建 Project 自动纳入。" : "仅所选 Project 的内容。"}
            {connectionMode === "collaborate" ? "可读写范围内的记录、文件与待办，恢复记录和文件历史版本，并撤销此连接自己的更改。" : "可读取范围内的记录、文件与待办。"}
            历史依据随范围授权自动开放；读取仍遵守 AI 排除和实际归属。
          </p>
          <div><Button size="sm" disabled={busy || (connectionScope === "project" && projectId === null) || !clientLabel.trim()} onClick={() => void run(() => externalConnectionsApi.create(binding, { clientLabel: clientLabel.trim(), projectIds: selectedProjectIds, workspaceContent: connectionScope === "workspace", allProjects: connectionScope === "workspace", writeOperations: selectedWriteOperations }))}>创建连接</Button></div>
        </div>}
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 border-t border-border pt-4">
          <h3 className="text-body font-medium text-text">已有连接</h3>
          {grants.length === 0 && <p className="text-ui text-text-secondary">暂无连接。</p>}
          {grants.map((grant) => {
            const legacyObjects = grant.objects !== null;
            const canCopy = grant.enabled && !grant.revokedAt && !legacyObjects && !!status.cliPath && !!status.workspacePath;
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
              <div className="flex items-center gap-2"><strong className="text-text">{grant.clientLabel}</strong><StatusBadge tone={grant.enabled && !grant.revokedAt && !legacyObjects ? "success" : "neutral"}>{grant.revokedAt ? "已撤销" : legacyObjects ? "需重新授权" : grant.enabled ? "有效" : "已停用"}</StatusBadge></div>
              <p className="break-words text-text-secondary">{grant.objects ? `指定 ${grant.objects.length} 个记录/文件` : grant.allProjects ? grant.workspaceContent ? "整个 Workspace（含新增 Project）" : "所有未归档 Project（含新增 Project）" : `${grant.workspaceContent ? "Workspace 内容；" : ""}Project：${grant.projectIds.map((id) => projectNames[id] ?? "已移除的项目").join("、") || "无"}`}；{grantPermissions(grant.operations)}{grant.operations.includes("session.read") ? "，包含会话依据" : ""}</p>
              {legacyObjects && <p className="text-danger">旧对象范围连接已停用。请重新选择 Workspace 或 Project 范围并创建连接。</p>}
              {grant.objects && <details className="min-w-0 text-text-secondary"><summary className="cursor-pointer">查看指定对象</summary><ul className="grid min-w-0 gap-1 pl-4">{grant.objects.map((object) => <li key={`${object.scope.kind}:${object.scope.kind === "project" ? object.scope.projectId : "workspace"}:${object.kind}:${object.id}`} className="break-all">{object.kind === "file" ? "文件" : "记录"} · {object.id} · {object.scope.kind === "project" ? projectNames[object.scope.projectId] ?? `Project ${object.scope.projectId}` : "Workspace 内容"}</li>)}</ul></details>}
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
