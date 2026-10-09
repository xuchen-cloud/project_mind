import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ProjectListItem } from "../../lib/types";
import type { AgentObjectRef } from "../../lib/agent-types";
import type { ExternalConnectionsStatus } from "../../lib/external-connections-types";
import { queryKeys } from "../../lib/queryKeys";
import { externalConnectionsApi } from "../../services/externalConnectionsApi";
import { projectMindApi } from "../../services/projectMindApi";
import { Button, SectionHeader, StatusBadge, TextField } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "../home/home.css";
import { CliInstallation } from "./CliInstallation";
import { ConnectionObjectPicker, type SelectedConnectionObject } from "./ConnectionObjectPicker";
import { settingsSelectClassName } from "./shared";

type ConnectionPreset = "workspace_collaborate" | "project_collaborate" | "read_only" | "custom";
const COLLABORATE_OPERATIONS = ["content.create", "record.patch", "todo.update", "file.update", "operation.undo"];
const OBJECT_EXCLUDED_OPERATIONS = new Set(["content.create", "todo.update"]);

function objectInScope(object: AgentObjectRef, projectIds: number[], workspaceContent: boolean) {
  return object.scope.kind === "workspace" ? workspaceContent : projectIds.includes(object.scope.projectId);
}

function shellQuote(value: string, shell: ExternalConnectionsStatus["cliShell"]) {
  return shell === "powershell"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

const WRITE_PERMISSION_OPTIONS = [
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
  const [customProjectIds, setCustomProjectIds] = useState<number[]>([]);
  const [preset, setPreset] = useState<ConnectionPreset>("workspace_collaborate");
  const [workspaceContent, setWorkspaceContent] = useState(false);
  const [sessionRead, setSessionRead] = useState(false);
  const [writeOperations, setWriteOperations] = useState<string[]>([]);
  const [objectsOnly, setObjectsOnly] = useState(false);
  const [selectedObjects, setSelectedObjects] = useState<SelectedConnectionObject[]>([]);
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
        setWorkspaceContent(false);
        setSessionRead(false);
        setWriteOperations([]);
        setObjectsOnly(false);
        setSelectedObjects([]);
        setCustomProjectIds([]);
        setProjectId(nextProjects.find((project) => !project.isArchived)?.id ?? null);
        setPreset("workspace_collaborate");
        loadedWorkspace.current = nextWorkspace;
      }
      setStatus(nextStatus);
      const active = nextProjects.filter((project) => !project.isArchived);
      setProjectNames(Object.fromEntries(nextProjects.map((project) => [project.id, project.name])));
      setProjects(active);
      if (!changedWorkspace) {
        setProjectId((current) => active.some((project) => project.id === current) ? current : active[0]?.id ?? null);
        setCustomProjectIds((current) => current.filter((id) => active.some((project) => project.id === id)));
        setSelectedObjects((current) => current.filter((item) => objectInScope(item.object, customProjectIds.filter((id) => active.some((project) => project.id === id)), workspaceContent)));
        if (active.length === 0) setPreset((current) => current === "project_collaborate" ? "workspace_collaborate" : current);
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
  const selectedProjectIds = preset === "project_collaborate" ? projectId === null ? [] : [projectId] : preset === "custom" ? customProjectIds : [];
  const selectedWorkspaceContent = preset !== "project_collaborate" && (preset !== "custom" || workspaceContent);
  const selectedAllProjects = preset === "workspace_collaborate" || preset === "read_only";
  const selectedWriteOperations = preset === "workspace_collaborate" || preset === "project_collaborate" ? COLLABORATE_OPERATIONS : preset === "custom" ? writeOperations.filter((operation) => !objectsOnly || !OBJECT_EXCLUDED_OPERATIONS.has(operation)) : [];

  function choosePreset(next: ConnectionPreset) {
    setPreset(next);
    setProjectId(projects[0]?.id ?? null);
    setCustomProjectIds([]);
    setWorkspaceContent(false);
    setWriteOperations([]);
    setObjectsOnly(false);
    setSelectedObjects([]);
  }

  function changeCustomProject(id: number, checked: boolean) {
    setCustomProjectIds((current) => checked ? [...current, id] : current.filter((value) => value !== id));
    if (!checked) setSelectedObjects((current) => current.filter((item) => item.object.scope.kind !== "project" || item.object.scope.projectId !== id));
  }

  function changeWorkspaceContent(checked: boolean) {
    setWorkspaceContent(checked);
    if (!checked) setSelectedObjects((current) => current.filter((item) => item.object.scope.kind !== "workspace"));
  }

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
            <legend className="mb-1">授权方式</legend>
            <label className="flex items-center gap-2"><input type="radio" name="connection-preset" checked={preset === "workspace_collaborate"} onChange={() => choosePreset("workspace_collaborate")} />Workspace 协作（推荐）</label>
            <label className="flex items-center gap-2"><input type="radio" name="connection-preset" checked={preset === "project_collaborate"} disabled={projects.length === 0} onChange={() => choosePreset("project_collaborate")} />单 Project 协作</label>
            <label className="flex items-center gap-2"><input type="radio" name="connection-preset" checked={preset === "read_only"} onChange={() => choosePreset("read_only")} />只读</label>
            <label className="flex items-center gap-2"><input type="radio" name="connection-preset" checked={preset === "custom"} onChange={() => choosePreset("custom")} />自定义</label>
          </fieldset>
          {preset === "project_collaborate" ? <label className="grid gap-1 text-ui text-text-secondary">授权的 Project
            <select className={`${settingsSelectClassName} min-w-0 max-w-full`} value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value ? Number(event.target.value) : null)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label> : preset === "custom" ? <div className="grid min-w-0 gap-2 text-ui text-text-secondary">
            <span>授权的 Project（可多选，最多 100 个）</span>
            {projects.length > 0 && <div className="flex h-40 min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-6)] border border-border p-2" style={{ "--home-sidebar": "var(--color-bg)" } as CSSProperties}>
              <HomeSidebarList label="授权的 Project">
                <div className="grid gap-1">
                  {projects.map((project) => <label key={project.id} className="flex min-w-0 items-start gap-2 py-1">
                    <input type="checkbox" className="mt-0.5" checked={customProjectIds.includes(project.id)} disabled={!customProjectIds.includes(project.id) && customProjectIds.length >= 100} onChange={(event) => changeCustomProject(project.id, event.target.checked)} />
                    <span className="min-w-0 break-words">{project.name}</span>
                  </label>)}
                </div>
              </HomeSidebarList>
            </div>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={workspaceContent} onChange={(event) => changeWorkspaceContent(event.target.checked)} />另外授权 Workspace 内容</label>
          </div> : null}
          {preset === "custom" && <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={objectsOnly} onChange={(event) => {
            setObjectsOnly(event.target.checked);
            setSelectedObjects([]);
            if (event.target.checked) {
              setSessionRead(false);
              setWriteOperations((current) => current.filter((operation) => !OBJECT_EXCLUDED_OPERATIONS.has(operation)));
            }
          }} />仅访问指定记录/文件</label>}
          {preset === "custom" && objectsOnly && <ConnectionObjectPicker key={`${binding.workspaceId}:${binding.generation}:${workspaceContent}:${customProjectIds.join(",")}`} binding={binding} projectScopes={projects.filter((project) => customProjectIds.includes(project.id))} workspaceContent={workspaceContent} selected={selectedObjects} onChange={setSelectedObjects} />}
          <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={sessionRead} disabled={objectsOnly} onChange={(event) => setSessionRead(event.target.checked)} />允许读取会话依据</label>
          {preset === "custom" && <details className="text-ui text-text-secondary">
            <summary className="cursor-pointer">自定义写入权限（可选）</summary>
            <p className="mt-2">不选择时只读；写入仅作用于上方授权范围。</p>
            <div className="mt-2 grid gap-2">
              {WRITE_PERMISSION_OPTIONS.filter((option) => !objectsOnly || !OBJECT_EXCLUDED_OPERATIONS.has(option.value)).map((option) => <label key={option.value} className="flex items-center gap-2">
                <input type="checkbox" checked={writeOperations.includes(option.value)} onChange={(event) => setWriteOperations((current) => event.target.checked ? [...current, option.value] : current.filter((value) => value !== option.value))} />
                {option.label}
              </label>)}
            </div>
          </details>}
          <p className="text-ui text-text-secondary">
            {preset === "workspace_collaborate" ? "包含 Workspace 直属内容和所有未归档 Project，新建 Project 自动纳入；可读取、新建和修改内容，并撤销此连接自己的更改。不含历史版本恢复。" : preset === "read_only" ? "包含 Workspace 直属内容和所有未归档 Project，新建 Project 自动纳入；只读。" : preset === "project_collaborate" ? "单个 Project 可读取、新建和修改 Record、待办与文件，并可撤销此连接自己的更改；不含 Workspace 内容或历史版本恢复。" : `自定义范围：${selectedProjectIds.length ? selectedProjectIds.map((id) => projectNames[id]).join("、") : "未选 Project"}${workspaceContent ? "、Workspace 内容" : ""}；${grantPermissions(selectedWriteOperations)}。`}
            {objectsOnly ? ` 仅指定 ${selectedObjects.length} 个记录/文件。` : sessionRead ? " 包含会话依据。" : " 不包含会话依据。"}
          </p>
          <div><Button size="sm" disabled={busy || (preset === "project_collaborate" && projectId === null) || (preset === "custom" && selectedProjectIds.length === 0 && !workspaceContent) || (objectsOnly && (selectedObjects.length < 1 || selectedObjects.length > 50)) || !clientLabel.trim()} onClick={() => void run(() => externalConnectionsApi.create(binding, { clientLabel: clientLabel.trim(), projectIds: selectedProjectIds, workspaceContent: selectedWorkspaceContent, allProjects: selectedAllProjects, sessionRead: objectsOnly ? false : sessionRead, writeOperations: selectedWriteOperations, objects: objectsOnly ? selectedObjects.map((item) => item.object) : null }))}>创建连接</Button></div>
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
              <p className="break-words text-text-secondary">{grant.objects ? `指定 ${grant.objects.length} 个记录/文件` : grant.allProjects ? grant.workspaceContent ? "整个 Workspace（含新增 Project）" : "所有未归档 Project（含新增 Project）" : `${grant.workspaceContent ? "Workspace 内容；" : ""}Project：${grant.projectIds.map((id) => projectNames[id] ?? "已移除的项目").join("、") || "无"}`}；{grantPermissions(grant.operations)}{grant.operations.includes("session.read") ? "，包含会话依据" : ""}</p>
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
