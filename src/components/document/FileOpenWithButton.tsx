import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { AgentObjectRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { NativeFileApplication } from "../../lib/file-types";
import { getErrorMessage } from "../../lib/errors";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { PopoverPanel } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "./file-open-with.css";

interface Props { workspaceRoot: string; projectId: number; fileId: number; visible: boolean; beforeOpen?: () => Promise<void>; onOpen: () => void; opening?: boolean; title?: string }
interface Choices { binding: AgentWorkspaceBinding; object: AgentObjectRef; applications: NativeFileApplication[] }

/** Application choice always targets the current original, independent of the viewed version. */
export function FileOpenWithButton({ workspaceRoot, projectId, fileId, visible, beforeOpen, onOpen, opening: defaultOpening = false, title }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const control = useRef<HTMLSpanElement>(null);
  const lookup = useRef<AbortController | null>(null);
  const request = useRef<AbortController | null>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const [choices, setChoices] = useState<Choices>();
  const [lookupError, setLookupError] = useState<string>();
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  function close(restoreFocus = false) {
    request.current?.abort(); request.current = null;
    setPosition(null); setError(undefined); setOpening(false);
    if (restoreFocus) trigger.current?.focus();
  }
  useEffect(() => {
    close();
    setChoices(undefined); setLookupError(undefined);
    if (visible) void loadApplications();
    return () => {
      lookup.current?.abort(); lookup.current = null;
      request.current?.abort(); request.current = null;
    };
  }, [workspaceRoot, projectId, fileId, visible]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !control.current?.contains(event.target as Node)) close();
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
  function show() {
    if (position) { close(true); return; }
    const rect = control.current!.getBoundingClientRect();
    const space = Math.max(12, window.innerHeight - 180);
    setPosition({ top: Math.min(rect.bottom + 6, space), right: Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - 188)) });
    setError(undefined);
    request.current = new AbortController();
  }
  async function loadApplications() {
    lookup.current?.abort();
    const lifetime = new AbortController(); lookup.current = lifetime;
    setLookupError(undefined); setChoices(undefined);
    try {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      lifetime.signal.throwIfAborted();
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: { kind: "project", projectId }, kind: "file", id: String(fileId) };
      const applications = await projectFileApi.applications(binding, object);
      lifetime.signal.throwIfAborted();
      setChoices({ binding, object, applications });
    } catch (cause) {
      if (!lifetime.signal.aborted) setLookupError(getErrorMessage(cause, "无法读取可用应用"));
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
  const defaultApplication = choices?.applications.find(application => application.isDefault);
  const disabled = opening || defaultOpening || !visible;
  return <>
    <span ref={control} className="file-open-with-control" role="group" aria-label="外部打开">
      <button type="button" className="file-open-with-control__primary" aria-label="在外部应用打开当前原件"
        title={title ?? (defaultApplication ? `使用${defaultApplication.name}打开当前原件` : "在外部应用打开当前原件")}
        disabled={disabled} onClick={() => { close(); onOpen(); }}>
        <span className="file-open-with-control__icon" aria-hidden="true">
          {defaultApplication?.icon ? <img src={defaultApplication.icon} alt="" width={20} height={20} /> : <ExternalLink size={16} />}
        </span>
      </button>
      <button ref={trigger} type="button" className="file-open-with-control__toggle" aria-label="选择其他应用打开当前原件" title="其他应用打开当前原件"
        aria-haspopup="dialog" aria-expanded={position !== null} aria-controls={position ? id : undefined} disabled={disabled} onClick={show}><ChevronDown size={12} aria-hidden="true" /></button>
    </span>
    {position && visible ? createPortal(<PopoverPanel ref={panel} id={id} role="dialog" aria-label="其他应用打开" tabIndex={-1} className="file-open-with" style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 12}px)` }} motion="trigger" motionOrigin="top right">
      <HomeSidebarList label="可用应用列表">
        {choices?.applications.map(application => <button key={application.id} type="button" className="file-open-with__application" disabled={opening} onClick={() => void choose(application.id)}>
          <span className="file-open-with__icon" aria-hidden="true" title={application.icon ? undefined : "系统应用图标不可用"}>
            {application.icon ? <img src={application.icon} alt="" width={20} height={20} /> : null}
          </span>
          <span className="file-open-with__name">{application.name}{application.isDefault ? <small>（默认）</small> : null}</span>
        </button>)}
        {!choices && !lookupError ? <p role="status">正在读取可用应用…</p> : null}
        {choices?.applications.length === 0 ? <p role="status">系统未注册可打开此文件的应用。</p> : null}
      </HomeSidebarList>
      {opening ? <p role="status">正在打开当前原件…</p> : null}
      {lookupError || error ? <p role="alert">{lookupError || error}</p> : null}
      {!choices && lookupError ? <button type="button" onClick={() => void loadApplications()}>重新读取</button> : null}
    </PopoverPanel>, document.body) : null}
  </>;
}
