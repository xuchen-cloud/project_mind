import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Clock, Plus } from "lucide-react";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { dshScheduleApi, type DshScheduledTask, type DshScheduledTaskInput, type DshScheduleRule } from "../../services/dshScheduleApi";
import { dshProjectRunKey, useAgentPanelStore } from "../../state/agent-panel-store";
import { getErrorMessage } from "../../lib/errors";
import { Button, Dialog, TextField } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "./scheduled-tasks.css";

type Session = { id: string; title: string };
const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function fresh(sessionId: string): DshScheduledTaskInput {
  return { title: "", prompt: "", sessionId, enabled: true, rule: { kind: "days", startDate: localDate(), time: "09:00", interval: 1 } };
}
function dateLabel(value: string | null) { return value ? new Date(value).toLocaleString() : "—"; }
function ruleLabel(rule: DshScheduleRule) {
  if (rule.kind === "hours") return `每 ${rule.interval} 小时`;
  if (rule.kind === "days") return `每 ${rule.interval} 天 ${rule.time}`;
  if (rule.kind === "weekdays") return `周一至周五 ${rule.time}`;
  if (rule.kind === "weeks") return `每 ${rule.interval} 周 · ${rule.weekdays?.map(day => dayNames[day - 1]).join("、")} ${rule.time}`;
  return `每月 ${rule.dayOfMonth} 日 ${rule.time}`;
}

export function ScheduledTasksPanel({ open, onRunStarted }: { open: boolean; onRunStarted?: () => void }) {
  const workspaceRoot = useAgentPanelStore(state => state.workspaceRoot);
  if (!workspaceRoot) return <p className="text-ui text-text-soft">请先打开工作区。</p>;
  return <WorkspaceScheduledTasks key={JSON.stringify([workspaceRoot, open])} workspaceRoot={workspaceRoot} open={open} onRunStarted={onRunStarted} />;
}

function WorkspaceScheduledTasks({ workspaceRoot, open, onRunStarted }: { workspaceRoot: string; open: boolean; onRunStarted?: () => void }) {
  const [tasks, setTasks] = useState<DshScheduledTask[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DshScheduledTaskInput | null>(null);
  const [editing, setEditing] = useState<DshScheduledTask | null>(null);
  const [deleting, setDeleting] = useState<DshScheduledTask | null>(null);
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const runRequests = useRef(new Map<string, string>());
  const alive = useRef(false);
  const mutation = useRef(false);
  const saveRequest = useRef<{ payload: string; id: string } | null>(null);
  const loadVersion = useRef(0);
  const scopeKey = dshProjectRunKey(workspaceRoot, null);
  const selected = useAgentPanelStore(state => state.workspaceSession);
  useLayoutEffect(() => { alive.current = open; return () => { alive.current = false; }; }, [open]);
  async function start() { await dshAssistantApi.start(scopeKey, null); }
  async function load() {
    const version = ++loadVersion.current;
    setLoading(true); setError(null);
    try {
      await start();
      if (!alive.current) return;
      const [saved, existing] = await Promise.all([dshScheduleApi.list(), dshAssistantApi.sessions(null)]);
      if (alive.current && version === loadVersion.current) { setTasks(saved); setSessions(existing); }
    } catch (reason) { if (alive.current && version === loadVersion.current) setError(getErrorMessage(reason, "读取定时任务失败")); }
    finally { if (alive.current && version === loadVersion.current) setLoading(false); }
  }
  useEffect(() => {
    if (!open) return;
    void load();
    const refresh = () => { if (!mutation.current) void load(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("mind:dsh-scheduled-tasks-changed", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("mind:dsh-scheduled-tasks-changed", refresh); };
  }, [open, workspaceRoot]);
  async function mutate(action: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true;
    ++loadVersion.current;
    setBusy(true); setError(null);
    try { await start(); if (alive.current) await action(); }
    catch (reason) { if (alive.current) setError(getErrorMessage(reason, "定时任务操作失败")); }
    finally { mutation.current = false; if (alive.current) { setBusy(false); setLoading(false); } }
  }
  async function run(task: DshScheduledTask) {
    const requestId = runRequests.current.get(task.id) ?? crypto.randomUUID();
    runRequests.current.set(task.id, requestId);
    await mutate(async () => {
      setRunningTask(task.id); setNotice(null);
      try {
        const saved = await dshScheduleApi.run(task.id, requestId);
        if (!alive.current) return;
        setTasks(values => values.map(value => value.id === saved.id ? saved : value));
        await dshAssistantApi.selectSession(saved.sessionId, null);
        if (!alive.current) return;
        useAgentPanelStore.getState().selectWorkspaceSession(workspaceRoot, saved.sessionId, sessions.find(session => session.id === saved.sessionId)?.title || saved.title);
        runRequests.current.delete(task.id);
        setNotice(`“${saved.title}”已发送到原会话，可在会话中查看 AI 执行结果。`);
        onRunStarted?.();
      } finally { if (alive.current) setRunningTask(null); }
    });
  }
  function begin(task?: DshScheduledTask) {
    saveRequest.current = null;
    setError(null);
    setEditing(task ?? null);
    setDraft(task ? { title: task.title, prompt: task.prompt, sessionId: task.sessionId, enabled: task.enabled, rule: { ...task.rule, weekdays: task.rule.weekdays?.slice() } } : fresh(selected?.workspaceRoot === workspaceRoot && sessions.some(session => session.id === selected.id) ? selected.id : sessions[0]?.id ?? ""));
  }
  function ruleKind(kind: DshScheduleRule["kind"]) {
    if (!draft) return;
    const { startDate, time } = draft.rule;
    setDraft({ ...draft, rule: { kind, startDate, time, ...(kind === "hours" || kind === "days" || kind === "weeks" ? { interval: 1 } : {}), ...(kind === "weeks" ? { weekdays: [1] } : {}), ...(kind === "monthly" ? { dayOfMonth: 1 } : {}) } });
  }
  async function save() {
    if (!draft) return;
    const input = { ...draft, title: draft.title.trim(), prompt: draft.prompt.trim() };
    const payload = JSON.stringify([editing?.id, input]);
    if (saveRequest.current?.payload !== payload) saveRequest.current = { payload, id: crypto.randomUUID() };
    const requestId = saveRequest.current.id;
    await mutate(async () => {
      const saved = editing ? await dshScheduleApi.update(editing.id, input, requestId) : await dshScheduleApi.create(input, requestId);
      if (alive.current) { setTasks(values => editing ? values.map(task => task.id === saved.id ? saved : task) : [...values, saved]); setDraft(null); setEditing(null); }
    });
  }
  return <section className="scheduled-tasks" aria-label="定时任务设置">
    <div className="scheduled-tasks__heading"><div><h2 className="text-title font-semibold text-text">定时任务</h2><p className="text-ui text-text-soft">在原工作区会话中持续执行，助手可查看整个工作区及所有项目。</p></div>
      <div className="scheduled-tasks__actions"><Button size="sm" variant="ghost" disabled={loading || busy} onClick={() => void load()}>刷新</Button><Button size="sm" leadingIcon={<Plus size={14} />} disabled={loading || busy} onClick={() => begin()}>新建定时任务</Button></div></div>
    <p className="text-ui text-text-soft">使用本机时区 {Intl.DateTimeFormat().resolvedOptions().timeZone}。应用运行且工作区已解锁时后台执行；恢复后补跑最近一次。</p>
    {error ? <div role="alert"><p>{error}</p><Button size="sm" disabled={busy} onClick={() => void load()}>重新读取</Button></div> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {loading ? <p role="status">正在读取定时任务…</p> : null}
    <div className="scheduled-tasks__list"><HomeSidebarList label="定时任务列表">
      {!loading && !tasks.length ? <p className="home-side__empty">暂无定时任务</p> : null}
      {tasks.map(task => <article key={task.id} className="scheduled-tasks__item">
        <div className="scheduled-tasks__heading"><h3><Clock size={14} />{task.title}</h3><span className="text-ui text-text-soft">{task.enabled ? "已启用" : "已暂停"}</span></div>
        <p className="text-ui text-text-muted">{ruleLabel(task.rule)} · {task.timeZone}</p><p className="text-ui text-text-soft">会话：{sessions.find(session => session.id === task.sessionId)?.title || task.sessionId}</p>
        <p className="text-ui text-text-soft">下次：{dateLabel(task.nextRunAt)}<br />上次：{dateLabel(task.lastRunAt)}</p>
        {task.lastError ? <p className="text-ui text-danger">{task.lastError}</p> : null}
        <div className="scheduled-tasks__actions"><Button size="sm" disabled={busy || loading} onClick={() => void run(task)}>{runningTask === task.id ? "正在触发…" : runRequests.current.has(task.id) ? "重试执行" : "立即执行"}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => begin(task)}>编辑</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(async () => { const saved = await dshScheduleApi.update(task.id, { title: task.title, prompt: task.prompt, sessionId: task.sessionId, rule: task.rule, enabled: !task.enabled }); if (alive.current) setTasks(values => values.map(value => value.id === saved.id ? saved : value)); })}>{task.enabled ? "暂停" : "启用"}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(task)}>删除</Button></div>
      </article>)}
    </HomeSidebarList></div>
    <Dialog open={draft !== null} title={editing ? "编辑定时任务" : "新建定时任务"} onClose={() => { if (!busy) setDraft(null); }} footer={<><Button disabled={busy} onClick={() => setDraft(null)}>取消</Button><Button disabled={busy || !draft?.title.trim() || !draft.prompt.trim() || !draft.sessionId || !draft.rule.startDate || !draft.rule.time || (draft.rule.kind === "weeks" && !draft.rule.weekdays?.length) || ((draft.rule.kind === "hours" || draft.rule.kind === "days" || draft.rule.kind === "weeks") && (!Number.isSafeInteger(draft.rule.interval) || (draft.rule.interval ?? 0) < 1)) || (draft.rule.kind === "monthly" && (!Number.isSafeInteger(draft.rule.dayOfMonth) || (draft.rule.dayOfMonth ?? 0) < 1 || (draft.rule.dayOfMonth ?? 0) > 31))} onClick={() => void save()}>保存任务</Button></>}>
      {draft ? <div className="scheduled-tasks__form">
        <label>任务名称<TextField aria-label="任务名称" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>任务内容<textarea className="scheduled-tasks__textarea" aria-label="任务内容" rows={4} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>
        <label>绑定会话<select aria-label="绑定会话" disabled={!!editing || busy} value={draft.sessionId} onChange={event => setDraft({ ...draft, sessionId: event.target.value })}><option value="" disabled>选择工作区会话</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title || "新会话"}</option>)}</select></label>
        {editing ? <p className="text-ui text-text-soft">绑定会话在创建后保持不变。</p> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(async () => { const id = await dshAssistantApi.selectSession(null, null); const existing = await dshAssistantApi.sessions(null); if (alive.current) { setSessions(existing); setDraft(value => value ? { ...value, sessionId: id } : value); } })}>新建工作区会话</Button>}
        <div className="scheduled-tasks__columns"><label>首次日期<TextField type="date" aria-label="首次日期" value={draft.rule.startDate} onChange={event => setDraft({ ...draft, rule: { ...draft.rule, startDate: event.target.value } })} /></label><label>执行时间<TextField type="time" aria-label="执行时间" value={draft.rule.time} onChange={event => setDraft({ ...draft, rule: { ...draft.rule, time: event.target.value } })} /></label></div>
        <label>重复方式<select aria-label="重复方式" value={draft.rule.kind} onChange={event => ruleKind(event.target.value as DshScheduleRule["kind"])}><option value="hours">每 N 小时</option><option value="days">每 N 天</option><option value="weekdays">周一至周五</option><option value="weeks">每 N 周</option><option value="monthly">每月指定日期</option></select></label>
        {draft.rule.kind === "hours" || draft.rule.kind === "days" || draft.rule.kind === "weeks" ? <label>重复间隔<TextField type="number" min={1} step={1} aria-label="重复间隔" value={draft.rule.interval ?? 1} onChange={event => setDraft({ ...draft, rule: { ...draft.rule, interval: Number(event.target.value) } })} /></label> : null}
        {draft.rule.kind === "weeks" ? <fieldset><legend>每周执行日</legend><div className="scheduled-tasks__days">{dayNames.map((name, index) => <label key={name}><input type="checkbox" checked={draft.rule.weekdays?.includes(index + 1) ?? false} onChange={event => { const days = draft.rule.weekdays ?? []; setDraft({ ...draft, rule: { ...draft.rule, weekdays: (event.target.checked ? [...days, index + 1] : days.filter(day => day !== index + 1)).sort((a, b) => a - b) } }); }} />{name}</label>)}</div></fieldset> : null}
        {draft.rule.kind === "monthly" ? <label>每月日期<TextField type="number" min={1} max={31} step={1} aria-label="每月日期" value={draft.rule.dayOfMonth ?? 1} onChange={event => setDraft({ ...draft, rule: { ...draft.rule, dayOfMonth: Number(event.target.value) } })} /><span className="text-ui text-text-soft">当月没有该日期时跳过。</span></label> : null}
        <p className="text-ui text-text-soft">时区：{editing?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}（本机时区）</p>
        <label className="scheduled-tasks__enabled"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用任务</label>
        {error ? <p role="alert" className="text-ui text-danger">{error}</p> : null}
      </div> : null}
    </Dialog>
    <Dialog open={!!deleting} title="删除定时任务" onClose={() => { if (!busy) setDeleting(null); }} footer={<><Button disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={() => { if (deleting) void mutate(async () => { await dshScheduleApi.delete(deleting.id); if (alive.current) { setTasks(values => values.filter(task => task.id !== deleting.id)); setDeleting(null); } }); }}>确认删除</Button></>}><p>删除“{deleting?.title}”？原会话与历史内容会保留。</p>{error ? <p role="alert" className="text-ui text-danger">{error}</p> : null}</Dialog>
  </section>;
}
