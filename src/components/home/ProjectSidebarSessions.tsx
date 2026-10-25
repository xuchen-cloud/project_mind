import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Clock, GitFork, LoaderCircle, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useUiStore } from "../../state/ui-store";
import { getErrorMessage } from "../../lib/errors";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { manageProjectSession, openProjectContent, type ProjectSessionAction } from "../../services/projectContentApi";
import { dshProjectRunKey, useAgentPanelStore } from "../../state/agent-panel-store";
import { AiChatIcon } from "../icons/ContentTypeIcon";
import { HomeSidebarList } from "./HomeSidebarList";
import { ActionContextMenu, Button, Dialog } from "../../ui/components";

export interface ProjectSidebarSessionsProps {
  workspaceRoot: string;
  projectId: number | null;
  query: string;
  enabled: boolean;
  activeSessionId?: string | null;
}

type Session = Awaited<ReturnType<typeof dshAssistantApi.sessions>>[number];

export function ProjectSidebarSessions(props: ProjectSidebarSessionsProps) {
  // Remount the async owner at every scope/visibility boundary, including A → B → A.
  return <ScopedSessions key={JSON.stringify([props.workspaceRoot, props.projectId, props.enabled])} {...props} />;
}

function ScopedSessions({ workspaceRoot, projectId, query, enabled, activeSessionId }: ProjectSidebarSessionsProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [opening, setOpening] = useState(false);
  const [busyLabel, setBusyLabel] = useState("正在打开会话");
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ session: Session; title: string } | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);
  const read = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const active = useRef(false);
  const scopeLabel = projectId === null ? "工作区" : "项目";
  const scopeKey = dshProjectRunKey(workspaceRoot, projectId);
  const sessionRuns = useAgentPanelStore(state => state.sessionsByProject[scopeKey]);

  useLayoutEffect(() => {
    active.current = enabled;
    return () => {
      active.current = false;
      read.current?.abort();
      action.current?.abort();
    };
  }, [enabled]);

  async function load() {
    if (!active.current) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    setError(null);
    try {
      const saved = await dshAssistantApi.sessions(projectId);
      if (!controller.signal.aborted) setSessions(saved);
    } catch (reason) {
      if (!controller.signal.aborted) setError({ message: getErrorMessage(reason, "读取项目会话失败"), retry: () => { void load(); } });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function open(session: Pick<Session, "id" | "title"> | null) {
    if (!active.current || action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setOpening(true);
    setBusyLabel("正在打开会话");
    setError(null);
    let target = session;
    try {
      const id = await dshAssistantApi.selectSession(session?.id ?? null, projectId);
      if (controller.signal.aborted) return;
      target = { id, title: session?.title || "新会话" };
      await openProjectContent({ workspaceRoot, projectId, object: { kind: "session", ...target }, signal: controller.signal });
      if (!controller.signal.aborted && !session) void load();
    } catch (reason) {
      // If creation succeeded but opening failed, retry the created session, never create a duplicate.
      if (!controller.signal.aborted) setError({ message: getErrorMessage(reason, "打开项目会话失败"), retry: () => { void open(target); } });
    } finally {
      if (!controller.signal.aborted) {
        action.current = null;
        setOpening(false);
      }
    }
  }

  async function manage(session: Session, change: ProjectSessionAction) {
    if (!active.current || action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setOpening(true);
    setBusyLabel("正在处理会话");
    setMenu(null);
    setEditing(null);
    setDeleting(null);
    setError(null);
    let forked: Pick<Session, "id" | "title"> | null = null;
    try {
      const id = await manageProjectSession({ workspaceRoot, projectId, sessionId: session.id, action: change, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (change.kind === "fork" && id) {
        forked = { id, title: session.title };
        await openProjectContent({ workspaceRoot, projectId, object: { kind: "session", ...forked }, signal: controller.signal });
      }
      if (!controller.signal.aborted) void load();
    } catch (reason) {
      if (!controller.signal.aborted) {
        const created = forked;
        setError({ message: getErrorMessage(reason, "会话操作失败"), retry: () => { if (created) void open(created); else void manage(session, change); } });
      }
    } finally {
      if (!controller.signal.aborted) {
        action.current = null;
        setOpening(false);
      }
    }
  }

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { void load(); };
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ projectId: number | null }>).detail.projectId === projectId) refresh();
    };
    window.addEventListener("mind:dsh-sessions-changed", changed);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      window.removeEventListener("mind:dsh-sessions-changed", changed);
      window.removeEventListener("focus", refresh);
    };
  }, [workspaceRoot, projectId, enabled]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = sessions.filter(session => session.title.toLocaleLowerCase().includes(needle));
  return <section className="project-navigation__section" aria-label={`${scopeLabel}会话`}>
    <div className="home-side__heading"><span>会话</span><div className="home-side__heading-actions">
      {loading || opening ? <span role="status" aria-label={opening ? busyLabel : "正在读取项目会话"} className="inline-flex"><LoaderCircle size={14} className="spin" aria-hidden="true" /></span> : null}
      {projectId === null ? <button type="button" aria-label="定时任务" title="定时任务" onClick={() => useUiStore.getState().openSettings("scheduled-tasks")}><Clock size={15} /></button> : null}
      <button type="button" aria-label="新增会话" title="新增会话" disabled={!enabled || loading || opening} onClick={() => { void open(null); }}><Plus size={16} /></button>
    </div></div>
    <HomeSidebarList label={`${scopeLabel}会话列表`} searchKey={query}>
      {error ? <div role="alert" className="home-side__empty"><p>{error.message}</p><button type="button" disabled={loading || opening} onClick={error.retry}>重试</button></div> : null}
      {visible.map(session => editing?.session.id === session.id ? <input key={session.id} autoFocus aria-label="重命名会话" className="home-side__rename"
        value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })}
        onBlur={() => { const title = editing.title.trim(); if (title && title !== session.title) void manage(session, { kind: "rename", title }); else setEditing(null); }}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setEditing(null); } else if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /> : <button key={session.id} type="button" className={`home-side__item ${session.id === activeSessionId ? "is-active" : ""}`} aria-current={session.id === activeSessionId ? "true" : undefined} title={session.title || "新会话"}
        disabled={opening} onClick={() => { void open(session); }}
        onContextMenu={event => { event.preventDefault(); if (!opening) setMenu({ session, x: event.clientX, y: event.clientY }); }}>
        <AiChatIcon size={12} /><span>{session.title || "新会话"}</span>
        {session.pinned ? <Pin size={12} aria-label="已置顶" /> : null}
        {sessionRuns?.[session.id] ? <LoaderCircle size={14} role="status" aria-label="运行中" aria-hidden={false} className="home-side__running spin" /> : null}
      </button>)}
      {enabled && !loading && !error && !visible.length ? <p className="home-side__empty">{needle ? "没有匹配的会话" : "暂无会话"}</p> : null}
    </HomeSidebarList>
    {menu ? createPortal(<ActionContextMenu x={menu.x} y={menu.y} ariaLabel="会话操作" onClose={() => setMenu(null)} actions={[
      { label: "重命名", icon: Pencil, onSelect: () => setEditing({ session: menu.session, title: menu.session.title }) },
      { label: menu.session.pinned ? "取消置顶" : "置顶", icon: menu.session.pinned ? PinOff : Pin, onSelect: () => void manage(menu.session, { kind: menu.session.pinned ? "unpin" : "pin" }) },
      { label: "分叉会话", icon: GitFork, onSelect: () => void manage(menu.session, { kind: "fork" }) },
      { label: "归档", icon: Archive, disabled: !!sessionRuns?.[menu.session.id], onSelect: () => void manage(menu.session, { kind: "archive" }) },
      { label: "删除", icon: Trash2, tone: "danger", disabled: !!sessionRuns?.[menu.session.id], onSelect: () => setDeleting(menu.session) },
    ]} />, document.body) : null}
    <Dialog open={!!deleting} title="删除会话" onClose={() => setDeleting(null)} footer={<>
      <Button onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" onClick={() => { if (deleting) void manage(deleting, { kind: "delete" }); }}>删除</Button>
    </>}>{deleting ? <p>删除“{deleting.title || "新会话"}”？会话将从当前范围移除，历史文件保留。</p> : null}</Dialog>
  </section>;
}
