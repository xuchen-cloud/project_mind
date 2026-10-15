import { useEffect, useState } from "react";
import type { AgentScopeSettings } from "../../lib/agent-types";
import { Button } from "../../ui/components";

type Schedule = Pick<AgentScopeSettings, "overviewIntervalHours" | "overviewLocalTime" | "overviewTimezone">;

export function AgentScheduleSettings({ settings, disabled, saving, onSave }: {
  settings: AgentScopeSettings | null;
  disabled: boolean;
  saving: boolean;
  onSave: (schedule: Schedule) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Schedule | null>(null);
  const [saved, setSaved] = useState<Schedule | null>(null);
  useEffect(() => {
    setDraft(settings ? {
      overviewIntervalHours: settings.overviewIntervalHours,
      overviewLocalTime: settings.overviewLocalTime,
      overviewTimezone: settings.overviewTimezone,
    } : null);
  }, [settings?.scope.kind, settings?.scope.kind === "project" ? settings.scope.projectId : null, settings?.revision]);
  if (!settings || !draft) return null;
  const changed = draft.overviewIntervalHours !== settings.overviewIntervalHours
    || draft.overviewLocalTime !== settings.overviewLocalTime
    || draft.overviewTimezone !== settings.overviewTimezone;
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.overviewLocalTime);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!changed || !validTime || !draft.overviewTimezone.trim() || disabled || saving) return;
    const next = { ...draft, overviewTimezone: draft.overviewTimezone.trim() };
    setSaved(await onSave(next) ? next : null);
  };
  return <form className="agent-panel__schedule" onSubmit={event => void submit(event)}>
    <strong>知识维护</strong>
    <p className="agent-panel__hint">应用运行时按本地时间维护变化的资料；错过的时段会在下次运行时合并处理。</p>
    <div className="agent-panel__schedule-fields">
      <label>频率<select aria-label="维护频率" value={draft.overviewIntervalHours} disabled={disabled || saving}
        onChange={event => { setSaved(null); setDraft({ ...draft, overviewIntervalHours: Number(event.target.value) as 24 | 48 }); }}>
        <option value={24}>每 24 小时</option><option value={48}>每 48 小时</option>
      </select></label>
      <label>本地时刻<input aria-label="维护时刻" type="time" required value={draft.overviewLocalTime} disabled={disabled || saving}
        onChange={event => { setSaved(null); setDraft({ ...draft, overviewLocalTime: event.target.value }); }} /></label>
      <label>时区<input aria-label="维护时区" type="text" required spellCheck={false} value={draft.overviewTimezone}
        placeholder="Asia/Shanghai" disabled={disabled || saving}
        onChange={event => { setSaved(null); setDraft({ ...draft, overviewTimezone: event.target.value }); }} /></label>
    </div>
    {settings.revision === 0 && !settings.enabled ? <p className="agent-panel__hint">首次启用助手时会采用此设备的时区。</p> : null}
    <div className="agent-panel__setting-row"><Button type="submit" size="sm" disabled={disabled || saving || !changed || !validTime || !draft.overviewTimezone.trim()}>
      {saving ? "保存中…" : "保存维护设置"}</Button>{saved && saved.overviewIntervalHours === settings.overviewIntervalHours && saved.overviewLocalTime === settings.overviewLocalTime && saved.overviewTimezone === settings.overviewTimezone ? <span className="agent-panel__hint" role="status">维护设置已保存</span> : null}</div>
  </form>;
}
