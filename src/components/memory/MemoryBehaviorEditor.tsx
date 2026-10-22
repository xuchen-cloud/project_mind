import { useEffect, useRef, useState } from "react";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import { getErrorMessage } from "../../lib/errors";
import { desktopApi } from "../../services/desktopApi";
import { Button } from "../../ui/components";

export interface MemoryBehavior { path: string; content: string; revision: string }
interface Props { binding: AgentWorkspaceBinding; onSaved?: (behavior: MemoryBehavior) => void }
export function MemoryBehaviorEditor(props: Props) {
  return <BehaviorEditor key={`${props.binding.workspaceId}:${props.binding.generation}`} {...props} />;
}
function BehaviorEditor({ binding, onSaved }: Props) {
  const [loaded, setLoaded] = useState<MemoryBehavior | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  async function load() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await desktopApi.command<MemoryBehavior>("memory_behavior_get", { binding });
      if (alive.current) { setLoaded(result); setContent(result.content); }
    } catch (reason) { if (alive.current) setError(getErrorMessage(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, []);
  async function save() {
    if (!loaded) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await desktopApi.command<MemoryBehavior>("memory_behavior_save", { binding, expectedRevision: loaded.revision, content });
      if (alive.current) { setLoaded(result); setContent(result.content); setSaved(true); onSaved?.(result); }
    } catch (reason) { if (alive.current) setError(getErrorMessage(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <section aria-label="记忆与整理行为" className="flex flex-col gap-2">
    <p className="text-ui text-text-secondary">所有项目共用这一份 Skill，下次请求读取新内容。整理时间由运行配置控制。</p>
    {loaded && <p className="break-all text-caption text-text-secondary">也可直接编辑文件：<code>{loaded.path}</code></p>}
    <label className="text-ui text-text-secondary">行为文件
      <textarea aria-label="行为文件" value={content} disabled={busy || !loaded} onChange={event => { setContent(event.target.value); setSaved(false); }} className="w-full resize-y rounded-[var(--radius-6)] border border-border bg-bg p-3 text-ui text-text outline-none focus:border-accent" style={{ minHeight: 240 }} />
    </label>
    {error && <p role="alert" className="text-ui text-danger">{error}。当前草稿已保留；重新读取会替换草稿，请先复制需要保留的修改。</p>}
    {saved && <p role="status" className="text-ui text-text-secondary">行为已保存，下次请求生效</p>}
    <div className="flex gap-2">
      <Button size="sm" disabled={busy || !loaded || content === loaded.content} onClick={() => void save()}>保存行为</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>重新读取行为</Button>
    </div>
  </section>;
}
