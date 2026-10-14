import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { assistantModel } from "../../lib/agent-model";
import { agentQueryKeys } from "../../lib/agent-query-keys";
import type { AgentScopeSettings } from "../../lib/agent-types";
import { publishAgentSettings, WORKSPACE_AGENT_SCOPE } from "../../lib/agent-workspace-settings";
import { queryKeys } from "../../lib/queryKeys";
import { agentApi } from "../../services/agentApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useUiStore } from "../../state/ui-store";
import { Button, SectionHeader } from "../../ui/components";
import { AgentScheduleSettings } from "../agent/AgentScheduleSettings";
import { agentFailureMessage } from "../../lib/agent-errors";
import "../agent/agent.css";

type SettingsPatch = Partial<Pick<AgentScopeSettings, "enabled" | "executionMode" | "overviewIntervalHours" | "overviewLocalTime" | "overviewTimezone">>;

export function AgentSettingsPanel({ open }: { open: boolean }) {
  const client = useQueryClient();
  const openSettings = useUiStore(state => state.openSettings);
  const status = useQuery({ queryKey: agentQueryKeys.status, queryFn: () => agentApi.statusGet(), enabled: open, retry: false });
  const binding = status.data?.binding;
  const key = binding ? agentQueryKeys.settings(binding, WORKSPACE_AGENT_SCOPE) : ["agent", "settings", "closed"];
  const settingsQuery = useQuery({ queryKey: key, queryFn: () => agentApi.settingsGet(binding!, WORKSPACE_AGENT_SCOPE), enabled: open && !!binding, retry: false });
  const ai = useQuery({ queryKey: queryKeys.aiSettings, queryFn: projectMindApi.aiSettingsGet, enabled: open });
  const settings = settingsQuery.data ?? null;
  const model = assistantModel(ai.data);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = !status.isFetching && !!binding && !!settings;

  async function save(patch: SettingsPatch): Promise<boolean> {
    if (!loaded || !binding || !settings || savingRef.current) return false;
    savingRef.current = true; setSaving(true); setError(null);
    try {
      const firstEnable = patch.enabled === true && !settings.enabled && settings.revision === 0;
      const next = { ...settings, ...(firstEnable ? { overviewTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}), ...patch };
      const saved = await agentApi.settingsUpdate(binding, { settings: next, expectedRevision: settings.revision });
      client.setQueryData(key, saved);
      publishAgentSettings(binding, saved);
      return true;
    } catch (failure) { setError(agentFailureMessage(failure)); return false; }
    finally { savingRef.current = false; setSaving(false); }
  }
  const loadError = status.error || settingsQuery.error || ai.error;
  return <div className="space-y-5">
    <SectionHeader title="助手" description="配置工作区知识维护与命令行助手；项目聊天的访问权限在会话内设置。" />
    {status.isPending || settingsQuery.isLoading ? <p role="status" className="text-body text-text-muted">正在读取助手设置…</p> : null}
    {!status.isPending && !binding && !status.error ? <p role="status">请先打开工作区。</p> : null}
    {loadError || error ? <div role="alert" className="space-y-2 text-body text-danger">
      <p>{error || agentFailureMessage(loadError)}</p>
      <Button size="sm" variant="ghost" onClick={() => { setError(null); void status.refetch(); void settingsQuery.refetch(); void ai.refetch(); }}>刷新设置</Button>
    </div> : null}
    <section className="space-y-3 border-b border-border pb-5" aria-label="助手行为">
      <label className="flex items-center gap-2 text-body text-text">
        <input type="checkbox" checked={settings?.enabled ?? false} disabled={!loaded || saving}
          onChange={event => void save({ enabled: event.target.checked })} />启用工作区助手
      </label>
      <label className="grid max-w-sm gap-1.5 text-body text-text">执行模式
        <select aria-label="执行模式" value={settings?.executionMode ?? "review"} disabled={!loaded || saving}
          className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-2"
          onChange={event => void save({ executionMode: event.target.value as AgentScopeSettings["executionMode"] })}>
          <option value="read_only">仅讨论</option><option value="review">确认后执行</option><option value="collaborate">自动执行</option>
        </select>
      </label>
      <p className="text-caption text-text-muted">仅讨论不会修改内容；确认后执行需要你批准；自动执行允许助手直接修改内容。正在运行的任务沿用启动时的模式。</p>
    </section>
    <section className="space-y-3 border-b border-border pb-5" aria-label="助手模型">
      <h3 className="text-ui font-medium text-text">助手模型</h3>
      <p className="text-body text-text">通用模型：{model.label}</p>
      <Button size="sm" variant="secondary" onClick={() => openSettings("ai-models")}>模型设置</Button>
      {ai.isPending ? <p role="status" className="text-caption text-text-muted">正在读取模型配置…</p>
        : model.reason ? <p role="status" className="text-caption text-text-muted">{model.reason}</p> : null}
      {!status.isPending && binding && !status.data?.runtimeAvailable ? <p role="status" className="text-caption text-text-muted">内置助手运行资源不可用，请检查应用安装。</p> : null}
    </section>
    <AgentScheduleSettings settings={settings} disabled={!loaded} saving={saving} onSave={save} />
  </div>;
}
