import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { AgentObjectRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { NativeFileApplication } from "../../lib/file-types";
import { getErrorMessage } from "../../lib/errors";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { PopoverPanel } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "./file-open-with.css";

interface Props { workspaceRoot: string; projectId: number; fileId: number; visible: boolean; beforeOpen?: () => Promise<void> }
interface Choices { binding: AgentWorkspaceBinding; object: AgentObjectRef; applications: NativeFileApplication[] }

/** Application choice always targets the current original, independent of the viewed version. */
export function FileOpenWithButton({ workspaceRoot, projectId, fileId, visible, beforeOpen }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const [choices, setChoices] = useState<Choices>();
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  function close(restoreFocus = false) {
    request.current?.abort(); request.current = null;
    setPosition(null); setChoices(undefined); setError(undefined); setOpening(false);
    if (restoreFocus) trigger.current?.focus();
  }
  useEffect(() => {
    close();
    return () => { request.current?.abort(); request.current = null; };
  }, [workspaceRoot, projectId, fileId, visible]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    const reposition = () => close();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
    };
  }, [position]);
  useEffect(() => {
    if (position) panel.current?.focus();
  }, [position]);
  async function show(retry = false) {
    if (position && !retry) { close(true); return; }
    request.current?.abort();
    const rect = trigger.current!.getBoundingClientRect();
    const space = Math.max(0, window.innerHeight - 180);
    setPosition({ top: Math.min(rect.bottom + 4, space), right: Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - 280)) });
    setError(undefined); setChoices(undefined);
    const lifetime = new AbortController(); request.current = lifetime;
    try {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      lifetime.signal.throwIfAborted();
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: { kind: "project", projectId }, kind: "file", id: String(fileId) };
      const applications = await projectFileApi.applications(binding, object);
      lifetime.signal.throwIfAborted();
      setChoices({ binding, object, applications });
    } catch (cause) {
      if (!lifetime.signal.aborted) setError(getErrorMessage(cause, "无法读取可用应用"));
    }
  }
  async function choose(applicationId: string) {
    if (!choices || opening) return;
    setOpening(true); setError(undefined);
    const lifetime = request.current!;
    try {
      if (beforeOpen) await beforeOpen();
      lifetime.signal.throwIfAborted();
      await projectFileApi.openWith(choices.binding, choices.object, applicationId);
      lifetime.signal.throwIfAborted();
      close(true);
    } catch (cause) {
      if (!lifetime.signal.aborted) { setError(getErrorMessage(cause, "无法在所选应用打开文件")); setOpening(false); }
    }
  }
  return <>
    <button ref={trigger} type="button" className="project-file-content__icon-button" aria-label="选择其他应用打开当前原件" title="其他应用打开当前原件"
      aria-haspopup="dialog" aria-expanded={position !== null} aria-controls={position ? id : undefined} disabled={opening || !visible} onClick={() => void show()}><ChevronDown size={12} aria-hidden="true" /></button>
    {position && visible ? createPortal(<PopoverPanel ref={panel} id={id} role="dialog" aria-label="其他应用打开" tabIndex={-1} className="file-open-with" style={position} motion="trigger" motionOrigin="top right">
      <header><strong>其他应用打开</strong><span>当前原件</span></header>
      <HomeSidebarList label="可用应用列表">
        {choices?.applications.map(application => <button key={application.id} type="button" className="file-open-with__application" disabled={opening} onClick={() => void choose(application.id)}>
          <span className="file-open-with__icon" aria-hidden="true" title={application.icon ? undefined : "系统应用图标不可用"}>
            {application.icon ? <img src={application.icon} alt="" width={20} height={20} /> : null}
          </span>
          <span>{application.name}</span>{application.isDefault ? <small>默认</small> : null}
        </button>)}
        {!choices && !error ? <p role="status">正在读取可用应用…</p> : null}
        {choices?.applications.length === 0 ? <p role="status">系统未注册可打开此文件的应用。</p> : null}
      </HomeSidebarList>
      {opening ? <p role="status">正在打开当前原件…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!choices && error ? <button type="button" onClick={() => void show(true)}>重新读取</button> : null}
    </PopoverPanel>, document.body) : null}
  </>;
}
