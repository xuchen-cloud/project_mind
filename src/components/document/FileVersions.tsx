import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "diff";
import type { AgentObjectRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { FileSourcePage, FileVersionMetadata, FileVersionPage } from "../../lib/file-types";
import { formatDateTime } from "../../lib/formatters";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { desktopApi } from "../../services/desktopApi";
import { AgentApiError } from "../../services/agentApi";
import { Button, Dialog } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "./file-versions.css";

function failureMessage(error: unknown) {
  if (error instanceof AgentApiError) {
    switch (error.code) {
      case "REVISION_CONFLICT": return "当前版本已经变化。请重新读取历史，再决定是否恢复。";
      case "FILE_CHANGED_UNREGISTERED": return "文件已在应用外修改。请先登记当前内容为新版本，再重新读取历史。";
      case "SOURCE_CHANGED": return "此版本的文件内容与登记校验值不同。请重新读取历史；当前文件发生外部修改时，请先登记当前内容。";
      case "SOURCE_NOT_READY": return "此版本尚无可核验的原件，或不支持文本读取。未经核验的旧版本不能恢复；可先登记当前内容为新版本。";
      case "WORKSPACE_CHANGED": return "工作区已切换，请关闭后重新打开版本历史。";
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Source pages replace each other; comparison reads one bounded complete snapshot per side. */
export default function FileVersions({ binding, object, title, mimeType, onClose, onRestored, onRegisterCurrent }: {
  binding: AgentWorkspaceBinding; object: AgentObjectRef; title: string; mimeType?: string;
  onClose: () => void; onRestored?: () => void | Promise<unknown>;
  onRegisterCurrent?: (expectedVersionNumber: number) => Promise<unknown>;
}) {
  const [page, setPage] = useState<FileVersionPage | null>(null);
  const [selected, setSelected] = useState<FileVersionMetadata | null>(null);
  const [source, setSource] = useState<FileSourcePage | null>(null);
  const [comparison, setComparison] = useState<{ before: FileSourcePage; after: FileSourcePage } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const identity = `${binding.workspaceId}:${binding.generation}:${JSON.stringify(object)}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const generation = useRef(0);
  const active = useRef(false);
  const actionId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { actionId.current++; active.current = false; setBusy(false); setNotice(null); }, [identity]);
  useEffect(() => {
    const token = ++generation.current;
    setPage(null); setSelected(null); setSource(null); setComparison(null); setError(null);
    void fileDocumentApi.versionsList(binding, { object, limit: 50 }).then(result => {
      if (mounted.current && token === generation.current) setPage(result);
    }).catch(failure => { if (mounted.current && token === generation.current) setError(failureMessage(failure)); });
  }, [identity, refresh]);

  async function action(work: () => Promise<void>) {
    if (active.current) return;
    const captured = currentIdentity.current;
    const operation = ++actionId.current;
    active.current = true; setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (failure) { if (mounted.current && captured === currentIdentity.current) setError(failureMessage(failure)); }
    finally { if (operation === actionId.current) { active.current = false; if (mounted.current && captured === currentIdentity.current) setBusy(false); } }
  }
  function stillCurrent(captured: string) { return mounted.current && captured === currentIdentity.current; }
  async function older() {
    if (!page || page.nextCursor === null) return;
    const baseline = page; const captured = identity;
    await action(async () => {
      const result = await fileDocumentApi.versionsList(binding, { object, cursor: baseline.nextCursor, limit: 50 });
      if (!stillCurrent(captured)) return;
      if (result.currentVersionNumber !== baseline.currentVersionNumber || result.currentContentHash !== baseline.currentContentHash) {
        setError("当前版本已经变化。请重新读取历史。"); return;
      }
      setPage({ ...baseline, versions: [...baseline.versions, ...result.versions.filter(version => !baseline.versions.some(old => old.id === version.id))], nextCursor: result.nextCursor });
    });
  }
  const textFile = (version: FileVersionMetadata) => mimeType?.startsWith("text/") || /\.(txt|md|markdown|html?|csv|json|ya?ml|xml|log|js|ts|css)$/i.test(version.name);
  async function read(version: FileVersionMetadata, cursor: string | null = null) {
    const captured = identity;
    setSelected(version); setSource(null); setComparison(null);
    if (!textFile(version)) { setError(null); return; }
    await action(async () => {
      const result = await fileDocumentApi.sourceRead(binding, { object, versionNumber: version.versionNumber, expectedContentHash: version.contentHash, cursor, budgetChars: 4000 });
      if (stillCurrent(captured)) setSource(result);
    });
  }
  async function compare() {
    if (!selected || !page) return;
    const captured = identity; const baseline = page; const version = selected;
    await action(async () => {
      const [before, after] = await Promise.all([
        fileDocumentApi.sourceRead(binding, { object, versionNumber: version.versionNumber, expectedContentHash: version.contentHash, budgetChars: 24000 }),
        fileDocumentApi.sourceRead(binding, { object, versionNumber: baseline.currentVersionNumber, expectedContentHash: baseline.currentContentHash, budgetChars: 24000 }),
      ]);
      if (!stillCurrent(captured)) return;
      if (!before.complete || !after.complete || before.totalChars > 24000 || after.totalChars > 24000) {
        setComparison(null); setNotice("文本超过完整比较预算，尚未比较全文。请按固定版本分页查看原文。"); return;
      }
      setComparison({ before, after });
    });
  }
  async function restore() {
    if (!selected || !page || !page.currentContentHash || !selected.contentHash) return;
    const captured = identity;
    const input = { object, versionId: selected.id, expectedVersionNumber: page.currentVersionNumber, expectedContentHash: page.currentContentHash };
    const requestId = crypto.randomUUID();
    await action(async () => {
      if (!await desktopApi.confirm(`将 v${selected.versionNumber} 恢复为新版本？当前 v${input.expectedVersionNumber} 和历史版本都会保留。`, "恢复文件版本")) return;
      if (!stillCurrent(captured)) return;
      const result = await fileDocumentApi.restore(binding, input, requestId);
      if (!stillCurrent(captured)) return;
      await onRestored?.();
      if (!stillCurrent(captured)) return;
      setRefresh(value => value + 1);
      setNotice(result.receipt.noChange ? `内容未变化，保留 v${result.receipt.versionNumber}。` : `已恢复为 v${result.receipt.versionNumber}。`);
    });
  }
  const differences = useMemo(() => comparison ? diffLines(comparison.before.text, comparison.after.text) : null, [comparison]);
  return <Dialog open title={`版本历史 · ${title}`} description="查看固定版本原文；恢复会保存为新版本，历史版本仍保留。" onClose={() => { if (!busy) onClose(); }} widthClassName="max-w-5xl" bodyClassName="overflow-hidden" layerClassName="z-40 file-versions"
    footer={<><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>关闭</Button><Button type="button" variant="primary" disabled={busy || !selected || selected.isCurrent || !selected.contentHash || !page?.currentContentHash} onClick={() => void restore()}>{busy ? "处理中…" : "恢复此版本"}</Button></>}>
    {error ? <p role="alert" className="mb-2 text-ui text-danger">{error}</p> : null}
    {notice ? <p role="status" className="mb-2 text-ui text-text-muted">{notice}</p> : null}
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" disabled={busy} onClick={() => { setRefresh(value => value + 1); }}>重新读取历史</Button>
      {onRegisterCurrent ? <Button type="button" size="sm" variant="ghost" disabled={busy || !page} onClick={() => void action(async () => { if (!page) return; const captured = identity; const result = await onRegisterCurrent(page.currentVersionNumber); if (stillCurrent(captured) && result) { await onRestored?.(); setRefresh(value => value + 1); } })}>登记当前内容为新版本</Button> : null}
      {page && !page.currentContentHash ? <span className="text-ui text-text-soft">当前版本未经核验，请先登记当前内容。</span> : null}
    </div>
    <div className="file-versions__columns">
      <div className="file-versions__versions"><HomeSidebarList label="文件版本">
        {!page && !error ? <p role="status" className="text-ui text-text-soft">正在读取历史…</p> : null}
        {page?.versions.length === 0 ? <p className="text-ui text-text-soft">没有可读版本。</p> : null}
        {page?.versions.map(version => <button type="button" key={version.id} disabled={busy} aria-label={`查看 v${version.versionNumber} · ${version.name}`} aria-pressed={version.id === selected?.id} className="file-versions__version" onClick={() => void read(version)}>
          <span>v{version.versionNumber}{version.isCurrent ? " · 当前" : ""}</span><span className="text-ui text-text-soft">{formatDateTime(version.createdAt)}</span><span className="break-words text-ui">{version.name}</span>{!version.contentHash ? <span className="text-ui text-text-soft">未经核验</span> : null}
        </button>)}
        {page?.nextCursor != null ? <Button type="button" size="sm" disabled={busy} onClick={() => void older()}>加载更早版本</Button> : null}
      </HomeSidebarList></div>
      <div className="file-versions__preview"><HomeSidebarList label="文件版本原文">
        {!selected ? <p className="text-ui text-text-soft">选择一个版本查看元数据与原文。</p> : <>
          <p className="text-ui font-medium">v{selected.versionNumber} · {selected.name}</p>
          {selected.contentHash ? <details className="text-ui text-text-soft"><summary>文件校验信息</summary><p className="break-all">{selected.contentHash}</p></details>
            : <p className="text-ui text-text-soft">此版本尚未登记校验信息。</p>}
          {!textFile(selected) ? <p className="text-ui text-text-muted">{mimeType || "二进制文件"} · 此格式仅查看版本元数据，请使用原版本菜单外部打开。</p> : null}
          {source ? <>
            <p className="text-ui text-text-soft">{source.byteLength} 字节 · 原文 {source.startChar}–{source.endChar} / {source.totalChars} 字符</p>
            <pre className="file-versions__text">{source.text}</pre>
            <div className="flex flex-wrap gap-2">{source.nextCursor ? <Button type="button" size="sm" disabled={busy} onClick={() => void read(selected, source.nextCursor)}>下一页原文</Button> : null}
              {!selected.isCurrent ? <Button type="button" size="sm" disabled={busy || !selected.contentHash || !page?.currentContentHash} onClick={() => void compare()}>与当前版本比较</Button> : null}</div>
          </> : null}
          {comparison && differences ? <div className="mt-3">
            <p className="mb-2 text-ui font-medium">v{comparison.before.versionNumber} → 当前 v{comparison.after.versionNumber} · 完整文本行差异</p>
            {comparison.before.text === comparison.after.text ? <p className="text-ui text-text-muted">文本内容相同。</p> : null}
            {differences.map((part, index) => <div key={index}>{part.added || part.removed ? <p className="text-ui text-text-soft">{part.added ? "新增" : "删除"} {part.count} 行</p> : null}<pre className="file-versions__text" data-change={part.added ? "added" : part.removed ? "removed" : "context"} aria-label={part.added ? "新增行" : part.removed ? "删除行" : "未变化行"}>{part.value}</pre></div>)}
          </div> : null}
        </>}
      </HomeSidebarList></div>
    </div>
  </Dialog>;
}
