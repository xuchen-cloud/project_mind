import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import type { RecordTarget, RecordVersion, RecordVersionCapacity, RecordVersionPage, RecordVersionPreview, RecordVersionOrigin } from "../../lib/record-document-types";
import type { RecordVersionDifference } from "../../lib/record-version-compare";
import { recordBlockDescriptions } from "../../lib/record-block-descriptions";
import { RecordVersionRestoreSession } from "../../lib/record-version-restore";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { Button, Dialog } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { RichEditor, type RichEditorAssetHandlers } from "../rich-editor";
import "./record-history.css";

const origins: Record<RecordVersionOrigin,string> = { baseline: "初始版本", manual: "手动编辑", agent: "智能助手", editor_ai: "接受 AI 内容", quick_note: "QuickNote 转存", restore: "恢复版本", import: "导入内容" };
function timestamp(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(); }
export default function RecordHistoryDialog({ binding, target, assetHandlers, onClose, onRestored }: {
  binding: AgentWorkspaceBinding; target: RecordTarget; assetHandlers?: RichEditorAssetHandlers;
  onClose: () => void; onRestored: () => void;
}) {
  const [page, setPage] = useState<RecordVersionPage | null>(null);
  const [capacity, setCapacity] = useState<RecordVersionCapacity | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RecordVersionPreview | null>(null);
  const [latest, setLatest] = useState<RecordVersion | null>(null);
  const [difference, setDifference] = useState<RecordVersionDifference | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);
  const active = useRef(false);
  const restoring = useMemo(() => new RecordVersionRestoreSession(), []);
  const current = useRef({ binding, target, onRestored });
  current.current = { binding,target,onRestored };
  const identity = `${binding.workspaceId}:${binding.generation}:${JSON.stringify(target)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestGeneration.current += 1; }; }, []);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    setPage(null); setCapacity(null); setPreview(null); setError(null); setConfirming(false);
    const { binding,target } = current.current;
    void Promise.all([recordDocumentApi.versionsList(binding,target), recordDocumentApi.capacity(binding,target)]).then(([nextPage,nextCapacity]) => {
      if (!mounted.current || generation !== requestGeneration.current) return;
      setPage(nextPage); setCapacity(nextCapacity);
      setSelectedId((previous) => nextPage.versions.some((version) => version.id === previous) ? previous : nextPage.versions[0]?.id ?? null);
    }).catch((failure) => { if (mounted.current && generation === requestGeneration.current) setError(String(failure)); });
  }, [identity,refresh]);
  const latestId = page?.versions[0]?.id;
  useEffect(() => {
    setPreview(null); setLatest(null); setDifference(null); setPreviewError(null); setConfirming(false);
    if (!selectedId || !latestId) return;
    let cancelled = false;
    const { binding,target } = current.current;
    void Promise.all([
      recordDocumentApi.versionPreview(binding,target,selectedId),
      selectedId === latestId ? Promise.resolve(null) : recordDocumentApi.versionGet(binding,target,latestId),
      selectedId === latestId ? Promise.resolve(null) : recordDocumentApi.versionsCompare(binding,target,selectedId,latestId),
    ]).then(([nextPreview,nextLatest,nextDifference]) => {
      if (cancelled) return;
      setPreview(nextPreview); setLatest(nextLatest ?? nextPreview.version); setDifference(nextDifference);
    }).catch((failure) => { if (!cancelled) setPreviewError(String(failure)); });
    return () => { cancelled = true; };
  }, [identity,selectedId,latestId,refresh]);
  async function loadOlder() {
    if (active.current || page?.nextBefore == null) return;
    active.current = true; setBusy(true); setError(null);
    const generation = requestGeneration.current;
    try {
      const older = await recordDocumentApi.versionsList(binding,target,page.nextBefore);
      if (!mounted.current || generation !== requestGeneration.current) return;
      setPage((previous) => previous ? { versions: [...previous.versions,...older.versions.filter((version) => !previous.versions.some((item) => item.id === version.id))], nextBefore: older.nextBefore } : older);
    } catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  async function restore() {
    if (!selectedId || active.current) return;
    active.current = true; setBusy(true); setError(null);
    try {
      await restoring.restore(binding,target,selectedId);
      if (!mounted.current) return;
      current.current.onRestored(); setConfirming(false); setRefresh((value) => value + 1);
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  const before = preview ? recordBlockDescriptions(preview.version.projection.document) : new Map<string,string>();
  const after = latest ? recordBlockDescriptions(latest.projection.document) : new Map<string,string>();
  return <Dialog open title="版本历史" description="每次重要修改都保留快照；恢复正文会形成新版本。" onClose={() => { if (!busy) onClose(); }} widthClassName="max-w-5xl" bodyClassName="overflow-hidden"
    footer={<>
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>关闭</Button>
      <Button type="button" variant="primary" disabled={busy || !preview || selectedId === latestId} onClick={() => setConfirming(true)}>恢复此版本</Button>
    </>}>
    {error ? <div role="alert" className="mb-3 text-ui text-danger"><p>{error}</p><Button type="button" size="sm" disabled={busy} onClick={() => { restoring.reset(); setRefresh((value) => value + 1); }}>重新读取历史</Button></div> : null}
    {confirming ? <div className="mb-3 rounded-[var(--radius-8)] border border-border p-3">
      <p className="text-body">恢复版本 {preview?.version.versionNumber} 的正文和代码语言？当前标题与标签会保留。</p>
      <div className="mt-2 flex gap-2"><Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => void restore()}>{busy ? "恢复中…" : "确认恢复正文"}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>取消</Button></div>
    </div> : null}
    {capacity ? <p className="mb-3 text-ui text-text-soft">{capacity.versionCount} 个版本 · 快照 {(capacity.snapshotBytes / 1024 / 1024).toFixed(2)} MB · {capacity.receiptCount} 条保存记录占 {(capacity.receiptBytes / 1024 / 1024).toFixed(2)} MB · 保留 {capacity.retainedAssetCount} 个资源</p> : null}
    <div className="record-history__columns">
      <div className="record-history__versions"><HomeSidebarList label="记录版本">
        {!page && !error ? <p role="status" className="text-ui text-text-soft">正在读取历史…</p> : null}
        {page?.versions.length === 0 ? <p className="text-ui text-text-soft">还没有历史版本。</p> : null}
        {page?.versions.map((version) => <button type="button" key={version.id} disabled={busy} aria-pressed={selectedId === version.id} className="record-history__version" onClick={() => setSelectedId(version.id)}>
          <span className="font-medium">版本 {version.versionNumber} · {origins[version.origin]}</span><span className="text-ui text-text-soft">{timestamp(version.createdAt)}</span>{version.titleSnapshot ? <span className="truncate text-ui text-text-muted">{version.titleSnapshot}</span> : null}
        </button>)}
        {page?.nextBefore != null ? <Button type="button" size="sm" disabled={busy} onClick={() => void loadOlder()}>加载更早版本</Button> : null}
      </HomeSidebarList></div>
      <div className="record-history__preview"><HomeSidebarList label="版本正文预览">
        {previewError ? <p role="alert" className="text-ui text-danger">{previewError}</p> : null}
        {selectedId && !preview && !previewError ? <p role="status" className="text-ui text-text-soft">正在读取版本正文…</p> : null}
        {preview ? <>
          <p className="mb-3 text-ui text-text-soft">版本 {preview.version.versionNumber} · {timestamp(preview.version.createdAt)}</p>
          {difference ? <div className="mb-4 grid gap-2 text-ui"><p className="font-medium">与最新版本相比</p>
            {([['added','新增'],['deleted','删除'],['modified','修改'],['moved','移动']] as const).map(([kind,label]) => <details key={kind}><summary>{label} {difference[kind].length} 块</summary><ul className="grid gap-2 py-2">
              {difference[kind].map((id) => <li key={id} className="rounded-[var(--radius-6)] bg-bg-subtle p-2">
                {kind === "modified" ? <><p className="text-text-soft">历史：{before.get(id) || "空块"}</p><p>最新：{after.get(id) || "空块"}</p></> : <p>{(kind === "deleted" ? before : after).get(id) || "空块"}</p>}
              </li>)}
            </ul></details>)}
          </div> : <p className="mb-3 text-ui text-text-soft">这是最新已保存版本。</p>}
          <RichEditor key={preview.version.id} variant="bare" showToolbar={false} readOnly defaultHtml={preview.html} defaultCodeLanguage={preview.version.projection.codeLanguage} assetHandlers={assetHandlers} />
        </> : null}
      </HomeSidebarList></div>
    </div>
  </Dialog>;
}
