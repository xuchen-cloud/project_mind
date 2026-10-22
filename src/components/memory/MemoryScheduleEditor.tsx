import { useEffect, useRef, useState } from "react";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import { getErrorMessage } from "../../lib/errors";
import { desktopApi } from "../../services/desktopApi";
import { Button, TextField } from "../../ui/components";
export interface MemorySchedule {
  enabled: boolean; intervalHours: number; localTime: string; timezone: string; revision: number;
  status: null | { phase: string; dueAt: string; error: string | null; receipt: null | { receipt: string; pending: boolean; proposalId: string | null } };
}
export function MemoryScheduleEditor({ binding }: { binding: AgentWorkspaceBinding }) {
  return <ScheduleEditor key={`${binding.workspaceId}:${binding.generation}`} binding={binding} />;
}
function ScheduleEditor({ binding }: { binding: AgentWorkspaceBinding }) {
  const [loaded, setLoaded] = useState<MemorySchedule | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [intervalHours, setIntervalHours] = useState(24);
  const [localTime, setLocalTime] = useState("");
  const [timezone, setTimezone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  function accept(result: MemorySchedule) {
    setLoaded(result); setEnabled(result.enabled); setIntervalHours(result.intervalHours); setLocalTime(result.localTime); setTimezone(result.timezone);
  }
  async function load() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await desktopApi.command<MemorySchedule>("memory_schedule_get", { binding, scope: { kind: "workspace" } });
      if (alive.current) accept(result);
    } catch (reason) { if (alive.current) setError(getErrorMessage(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  async function save() {
    if (!loaded) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await desktopApi.command<MemorySchedule>("memory_schedule_save", { binding, scope: { kind: "workspace" }, input: { enabled, intervalHours, localTime, timezone, expectedRevision: loaded.revision } });
      if (alive.current) { accept(result); setSaved(true); }
    } catch (reason) { if (alive.current) setError(getErrorMessage(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  const changed = loaded && (enabled !== loaded.enabled || intervalHours !== loaded.intervalHours || localTime !== loaded.localTime || timezone !== loaded.timezone);
  const status = loaded?.status;
  const phase = status?.phase === "completed" ? status.receipt?.pending ? "待批准" : "已完成" : status?.phase === "failed" ? "整理失败" : status?.phase === "generating" ? "正在整理" : "等待应用";
  return <section aria-label="自动整理时间" className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
    <p className="text-ui text-text-secondary">工作区助手、项目理解和记忆整理共用此开关与时间。</p>
    <fieldset disabled={busy || !loaded} className="flex flex-col gap-2" onChange={() => setSaved(false)}>
      <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用工作区助手与自动整理</label>
      <div className="flex flex-wrap gap-3">
        <label className="text-ui text-text-secondary">整理间隔<select aria-label="整理间隔" className="memory-editor__select" value={intervalHours} onChange={event => setIntervalHours(Number(event.target.value))}><option value={24}>每 24 小时</option><option value={48}>每 48 小时</option></select></label>
        <label className="text-ui text-text-secondary">当地时间<TextField aria-label="当地时间" type="time" value={localTime} onChange={event => setLocalTime(event.target.value)} /></label>
        <label className="text-ui text-text-secondary">时区<TextField aria-label="时区" value={timezone} placeholder="Asia/Shanghai" onChange={event => setTimezone(event.target.value)} /></label>
      </div>
    </fieldset>
    {status && <p className="text-caption text-text-secondary">最近整理：{phase}{loaded?.enabled && ` · 下次计划：${new Date(status.dueAt).toLocaleString()}`}</p>}
    {status?.error && <p className="text-caption text-danger">最近整理错误：{status.error}</p>}
    {error && <p role="alert" className="text-ui text-danger">{error}。当前修改已保留；重新读取会替换未保存的设置。</p>}
    {saved && <p role="status" className="text-ui text-text-secondary">整理时间已保存</p>}
    <div className="flex gap-2"><Button size="sm" disabled={busy || !changed || !localTime || !timezone.trim()} onClick={() => void save()}>保存整理时间</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>重新读取整理时间</Button></div>
  </section>;
}
