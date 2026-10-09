import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { AgentObjectRef, AgentScope, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { ConnectionObjectPage } from "../../lib/external-connections-types";
import { externalConnectionsApi } from "../../services/externalConnectionsApi";
import { Button, TextField } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { settingsSelectClassName } from "./shared";

export type SelectedConnectionObject = { object: AgentObjectRef; title: string };

function objectKey(object: AgentObjectRef) {
  return `${object.workspaceId}:${object.scope.kind}:${object.scope.kind === "project" ? object.scope.projectId : ""}:${object.kind}:${object.id}`;
}

function objectScopeLabel(object: AgentObjectRef, projectScopes: { id: number; name: string }[]) {
  if (object.scope.kind === "workspace") return "Workspace 内容";
  const projectId = object.scope.projectId;
  return projectScopes.find((scope) => scope.id === projectId)?.name ?? `Project ${projectId}`;
}

export function ConnectionObjectPicker({ binding, projectScopes, workspaceContent, selected, onChange }: {
  binding: AgentWorkspaceBinding;
  projectScopes: { id: number; name: string }[];
  workspaceContent: boolean;
  selected: SelectedConnectionObject[];
  onChange: (next: SelectedConnectionObject[]) => void;
}) {
  const scopes: { value: string; label: string; scope: AgentScope }[] = [
    ...(workspaceContent ? [{ value: "workspace", label: "Workspace 内容", scope: { kind: "workspace" } as AgentScope }] : []),
    ...projectScopes.map((project) => ({ value: `project:${project.id}`, label: project.name, scope: { kind: "project", projectId: project.id } as AgentScope })),
  ];
  const [scopeValue, setScopeValue] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ConnectionObjectPage["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const activeScope = scopes.find((scope) => scope.value === scopeValue) ?? scopes[0];
  const activeKey = activeScope?.value ?? "";

  useEffect(() => {
    const generation = ++epoch.current;
    if (!cursor) setItems([]);
    setNextCursor(null);
    setError(null);
    if (!activeScope) { setLoading(false); return; }
    setLoading(true);
    void externalConnectionsApi.objects(binding, { scope: activeScope.scope, query: query.slice(0, 200), cursor })
      .then((page) => {
        if (epoch.current !== generation) return;
        setItems((current) => cursor ? [...current, ...page.items] : page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((reason: unknown) => { if (epoch.current === generation) setError(String(reason)); })
      .finally(() => { if (epoch.current === generation) setLoading(false); });
    return () => { epoch.current++; };
    // activeKey identifies the selected scope; scope objects are rebuilt each render.
  }, [binding.workspaceId, binding.generation, activeKey, query, cursor]);

  function changeScope(value: string) { setScopeValue(value); setCursor(null); }
  function changeQuery(value: string) { setQuery(value.slice(0, 200)); setCursor(null); }
  function toggle(item: SelectedConnectionObject) {
    const key = objectKey(item.object);
    onChange(selected.some((entry) => objectKey(entry.object) === key)
      ? selected.filter((entry) => objectKey(entry.object) !== key)
      : selected.length < 50 ? [...selected, item] : selected);
  }

  return <div className="grid min-w-0 gap-2 text-ui text-text-secondary" data-testid="connection-object-picker">
    <p>仅所选记录/文件可读取和修改；不含新增内容、会话和范围级摘要。可用 source 搜索或直接对象工具。</p>
    <p>已选 {selected.length}/50 个记录/文件</p>
    {selected.length > 0 && <div className="grid min-w-0 gap-1">
      {selected.map((item) => <div key={objectKey(item.object)} className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 break-words">{item.title}（{item.object.kind === "file" ? "文件" : "记录"} · {objectScopeLabel(item.object, projectScopes)}）</span>
        <Button size="sm" variant="ghost" onClick={() => toggle(item)} aria-label={`移除 ${item.title}`}>移除</Button>
      </div>)}
    </div>}
    {scopes.length === 0 ? <p>先选择 Project 或 Workspace 内容。</p> : <>
      <label className="grid min-w-0 gap-1">搜索范围
        <select className={`${settingsSelectClassName} min-w-0 max-w-full`} value={activeKey} onChange={(event) => changeScope(event.target.value)}>
          {scopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
        </select>
      </label>
      <label className="grid gap-1">搜索记录或文件<TextField value={query} maxLength={200} onChange={(event) => changeQuery(event.target.value)} placeholder="输入标题" /></label>
      {error && <p role="alert" className="text-danger">{error}</p>}
      <div className="flex h-40 min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-6)] border border-border p-2" style={{ "--home-sidebar": "var(--color-bg)" } as CSSProperties}>
        <HomeSidebarList label="可选记录和文件" searchKey={`${activeKey}:${query}`}>
          <div className="grid gap-1">
            {items.map((item) => {
              const checked = selected.some((entry) => objectKey(entry.object) === objectKey(item.object));
              return <label key={objectKey(item.object)} className="flex min-w-0 items-start gap-2 py-1">
                <input type="checkbox" className="mt-0.5" checked={checked} disabled={!checked && selected.length >= 50} onChange={() => toggle(item)} />
                <span className="min-w-0 break-words">{item.title}（{item.object.kind === "file" ? "文件" : "记录"}）</span>
              </label>;
            })}
            {!loading && items.length === 0 && <p>没有匹配的记录或文件。</p>}
          </div>
        </HomeSidebarList>
      </div>
      {loading && <p role="status">正在搜索…</p>}
      {nextCursor && <Button size="sm" variant="ghost" disabled={loading} onClick={() => setCursor(nextCursor)}>加载更多</Button>}
    </>}
  </div>;
}
