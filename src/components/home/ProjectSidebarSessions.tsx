import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { getErrorMessage } from "../../lib/errors";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { openProjectContent } from "../../services/projectContentApi";
import { dshProjectRunKey, useAgentPanelStore } from "../../state/agent-panel-store";
import { AiChatIcon } from "../icons/ContentTypeIcon";
import { HomeSidebarList } from "./HomeSidebarList";

export interface ProjectSidebarSessionsProps {
  workspaceRoot: string;
  projectId: number;
  query: string;
  enabled: boolean;
}

type Session = Awaited<ReturnType<typeof dshAssistantApi.sessions>>[number];

export function ProjectSidebarSessions(props: ProjectSidebarSessionsProps) {
  // Remount the async owner at every scope/visibility boundary, including A → B → A.
  return <ScopedSessions key={JSON.stringify([props.workspaceRoot, props.projectId, props.enabled])} {...props} />;
}

function ScopedSessions({ workspaceRoot, projectId, query, enabled }: ProjectSidebarSessionsProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);
  const read = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const active = useRef(false);
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

  async function start() {
    // The runtime catalog owns running state; a sidebar refresh must not restart a run.
    if (!useAgentPanelStore.getState().runsByProject[scopeKey]) {
      await dshAssistantApi.start(scopeKey, projectId);
    }
  }

  async function load() {
    if (!active.current) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    setError(null);
    try {
      await start();
      if (controller.signal.aborted) return;
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
    setError(null);
    let target = session;
    try {
      await start();
      if (controller.signal.aborted) return;
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

  useEffect(() => { void load(); }, [workspaceRoot, projectId, enabled]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = sessions.filter(session => session.title.toLocaleLowerCase().includes(needle));
  return <section className="project-navigation__section" aria-label="项目会话">
    <div className="home-side__heading"><span>会话</span><div className="home-side__heading-actions">
      <button type="button" aria-label="刷新会话" title="刷新会话" disabled={!enabled || loading || opening} onClick={() => { void load(); }}><RefreshCw size={16} /></button>
      <button type="button" aria-label="新增会话" title="新增会话" disabled={!enabled || loading || opening} onClick={() => { void open(null); }}><Plus size={16} /></button>
    </div></div>
    <HomeSidebarList label="项目会话列表" searchKey={query}>
      {error ? <div role="alert" className="home-side__empty"><p>{error.message}</p><button type="button" disabled={loading || opening} onClick={error.retry}>重试</button></div> : null}
      {loading ? <p role="status" className="home-side__empty">正在读取项目会话…</p> : null}
      {opening ? <p role="status" className="home-side__empty">正在打开会话…</p> : null}
      {!loading && visible.map(session => <button key={session.id} type="button" className="home-side__item" title={session.title || "新会话"}
        disabled={opening} onClick={() => { void open(session); }}>
        <AiChatIcon size={12} /><span>{session.title || "新会话"}</span>
        {sessionRuns?.[session.id] ? <span aria-label="运行中">运行中</span> : null}
      </button>)}
      {enabled && !loading && !error && !visible.length ? <p className="home-side__empty">{needle ? "没有匹配的会话" : "暂无会话"}</p> : null}
    </HomeSidebarList>
  </section>;
}
