import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryKeys";
import type { AgentObjectRef, AgentSourceRef } from "../../lib/agent-types";
import type { FileVersionMetadata } from "../../lib/file-types";
import { readCompleteFileSource } from "../../lib/file-source";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileBytes, projectFileApi } from "../../services/projectFileApi";
import { markdownImageReferences, localResourcePath } from "../../../packages/dsh-ui/preview/resources.mjs";
import { prepareStaticHtml } from "../../../packages/dsh-ui/preview/static-html.mjs";
import { DshFilePreview, type DshPreviewKind } from "../../../packages/dsh-ui/preview";
import "./project-file-content.css";

export interface ProjectFileView { versionNumber?: number; line?: number; page?: number; scrollTop?: number; zoom?: number; sourceLocator?: NonNullable<AgentSourceRef["locator"]>; sourceMode?: boolean }
export interface ProjectFileContentProps {
  workspaceRoot: string; projectId: number; fileId: number; versionNumber?: number; line?: number; page?: number;
  /** View for the selected File version; zoom 0 means fit width. */
  initialView?: { scrollTop?: number; zoom?: number };
  initialSourceMode?: boolean;
  sourceLocator?: NonNullable<AgentSourceRef["locator"]>;
  onSourceReady?: (source: AgentSourceRef | null) => void;
  visible: boolean; focused: boolean; onViewChange?: (partialView: ProjectFileView) => void;
}
type Kind = DshPreviewKind | "html" | "unsupported";
export function projectFilePreviewKind(name: string, mime: string): Kind {
  if (/\.html?$/iu.test(name) || mime === "text/html") return "html";
  if (/\.md(?:own|arkdown)?$/iu.test(name)) return "markdown";
  if (/\.pdf$/iu.test(name) || mime === "application/pdf") return "pdf";
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/iu.test(name)) return "image";
  if (/\.(docx?|xlsx?|pptx?|zip|exe|bin|mp[34]|mov|wav|woff2?|ttf)$/iu.test(name)) return "unsupported";
  if (/\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|css|scss|json|toml|ya?ml|sql|xml)$/iu.test(name)) return "code";
  if (/^(text\/|application\/(json|xml))/u.test(mime) || /\.(txt|log|csv)$/iu.test(name) || /^(readme|license)$/iu.test(name)) return "text";
  return "unsupported";
}
interface Loaded { resources: Record<string,string>; warnings:string[]; name: string; renderName: string; kind: Kind; text?: string; bytes?: Uint8Array; version: number; contentHash: string; rendererId: number; versions: FileVersionMetadata[]; signal: AbortSignal }
function sameObject(a: AgentObjectRef, b: AgentObjectRef) {
  return a?.workspaceId === b.workspaceId && a.id === b.id && a.kind === b.kind && a.scope?.kind === "project" && b.scope.kind === "project" && a.scope.projectId === b.scope.projectId;
}
function message(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}
/** The object is the component identity; versions are viewing state within that object. */
export function ProjectFileContent(props: ProjectFileContentProps) {
  return <FileContent key={`${props.workspaceRoot}:${props.projectId}:${props.fileId}`} {...props} />;
}
function FileContent({ workspaceRoot, projectId, fileId, versionNumber, line, page, sourceLocator, initialView, initialSourceMode, visible, focused, onViewChange, onSourceReady }: ProjectFileContentProps) {
  const queryClient = useQueryClient();
  const views = useRef(new Map<number, ProjectFileView>());
  const dependentIds = useRef(new Set<number>());
  const [selection, setSelection] = useState(versionNumber);
  const [reload, setReload] = useState(0);
  const [availableVersions, setAvailableVersions] = useState<FileVersionMetadata[]>([]);
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [source, setSource] = useState(initialSourceMode ?? false);
  const lastSourceMode = useRef(initialSourceMode);
  const sourceMode = useRef(source); sourceMode.current = source;
  const rendererSequence = useRef(0);
  const callbacks = useRef(onViewChange); callbacks.current = onViewChange;
  const sourceCallback = useRef(onSourceReady); sourceCallback.current = onSourceReady;
  const lastRequested = useRef(versionNumber);
  useEffect(() => {
    if (initialSourceMode !== lastSourceMode.current) {
      lastSourceMode.current = initialSourceMode;
      if (initialSourceMode !== undefined) setSource(initialSourceMode);
    }
  }, [initialSourceMode]);
  useEffect(() => {
    if (!visible && source) setLoaded(undefined);
  }, [visible, source]);
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    const key = event.query.queryKey;
    if (selection === undefined && event.type === "updated" && event.action.type === "invalidate" && key[0] === queryKeys.documentVersions(fileId)[0] && (key[1] === fileId || dependentIds.current.has(Number(key[1])))) setReload(value => value + 1);
  }), [queryClient, selection, fileId]);
  // A parent view update acknowledges local version choices without resetting other view state.
  useEffect(() => {
    if (lastRequested.current !== versionNumber) { lastRequested.current = versionNumber; setSelection(versionNumber); }
  }, [versionNumber]);
  useEffect(() => {
    dependentIds.current.clear();
    sourceCallback.current?.(null);
    const retainStaticHtml = (previous: Loaded | undefined) => previous?.kind === "html" && !sourceMode.current && (selection === undefined || previous.version === selection) ? previous : undefined;
    if (!visible) { setLoaded(retainStaticHtml); setReading(false); return; }
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    setLoaded(retainStaticHtml); setError(undefined); setReading(true);
    void (async () => {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      signal.throwIfAborted();
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: { kind: "project", projectId }, kind: "file", id: String(fileId) };
      const live = selection === undefined ? await projectFileApi.resolve(binding, object) : undefined;
      signal.throwIfAborted();
      if (live) setLoaded(previous => previous?.kind === "html" && live.state === "ready" && previous.version === live.versionNumber && previous.contentHash === live.contentHash ? previous : undefined);
      const history = await fileDocumentApi.versionsList(binding, { object, limit: 50 });
      signal.throwIfAborted();
      if (!sameObject(history.object, object)) throw new Error("文件版本所属项目不符。");
      setAvailableVersions(history.versions);
      if (live && live.state !== "ready") throw new Error(live.reason ?? "当前文件待核对或不可用；可选择保留的历史版本。");
      const version = selection ?? live!.versionNumber;
      let selected = history.versions.find(item => item.versionNumber === version);
      let versions = history.versions;
      if (!selected && selection !== undefined) {
        const older = await fileDocumentApi.versionsList(binding, { object, cursor: selection + 1, limit: 1 });
        signal.throwIfAborted();
        if (!sameObject(older.object, object)) throw new Error("历史版本所属项目不符。");
        selected = older.versions.find(item => item.versionNumber === selection);
        if (selected) versions = [...versions, selected];
      }
      setAvailableVersions(versions);
      if (!selected) throw new Error("此历史版本不存在或已不可用；不会替换为最新版本。");
      if (live && (live.versionNumber !== history.currentVersionNumber || live.contentHash !== selected.contentHash)) throw new Error("文件在对账后发生变化，请刷新。");
      if (!selected.contentHash) throw new Error("此版本尚未登记完整原件校验信息。");
      setLoaded(previous => previous?.kind === "html" && previous.version === version && previous.contentHash === selected.contentHash ? previous : undefined);
      const input = { object, versionNumber: version, expectedContentHash: selected.contentHash };
      const result = await projectFileApi.readBytes(binding, input);
      signal.throwIfAborted();
      if (!sameObject(result.object, object) || result.versionNumber !== version || result.contentHash !== selected.contentHash) throw new Error("文件字节与请求的固定版本不一致。");
      const bytes = fileBytes(result);
      if (bytes.byteLength !== result.byteLength) throw new Error("文件字节不完整。");
      const kind = projectFilePreviewKind(result.name, result.mime);
      let text: string | undefined;
      // Native source pagination verifies the same immutable version/hash on every page.
      if (kind === "text" || kind === "markdown" || kind === "html") text = (await readCompleteFileSource(binding, input, signal)).text;
      else if (kind === "code") text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      signal.throwIfAborted();
      const resources: Record<string,string> = {}; const warnings: string[] = [];
      let displayBytes = bytes;
      let assetCount = 0; let totalBytes = bytes.byteLength;
      const resourceCache = new Map<string, Promise<Awaited<ReturnType<typeof projectFileApi.readBytes>>>>();
      const readRelated = (relativePath: string, resourceSignal: AbortSignal) => {
        const retained = resourceCache.get(relativePath);
        if (retained) return retained;
        const pending = (async () => {
          resourceSignal.throwIfAborted();
          if (selection !== undefined) throw new Error("此历史版本未保留关联资源快照");
          if (++assetCount > 64) throw new Error("关联资源超过 64 项上限");
          const resolved = await projectFileApi.resolveRelated(binding, object, relativePath);
          resourceSignal.throwIfAborted();
          if (resolved.state !== "ready" || !resolved.contentHash) throw new Error(resolved.reason ?? "关联资源尚无完整已登记版本");
          const related = await projectFileApi.readBytes(binding, { object: resolved.object, versionNumber: resolved.versionNumber, expectedContentHash: resolved.contentHash });
          resourceSignal.throwIfAborted();
          if (related.object.scope.kind !== "project" || related.object.scope.projectId !== projectId || related.object.workspaceId !== binding.workspaceId || related.versionNumber !== resolved.versionNumber || related.contentHash !== resolved.contentHash || !sameObject(related.object, resolved.object)) throw new Error("关联资源所属项目或版本不符");
          dependentIds.current.add(Number(related.object.id));
          const actual = fileBytes(related);
          if (actual.byteLength !== related.byteLength) throw new Error("关联资源字节不完整");
          if (related.byteLength > 4 * 1024 * 1024 || (totalBytes += related.byteLength) > 32 * 1024 * 1024) throw new Error("关联资源超过预览字节预算");
          return related;
        })();
        resourceCache.set(relativePath, pending); return pending;
      };
      if (kind === "markdown") {
        for (const reference of markdownImageReferences(text!)) {
          try {
            if (/^data:image\//iu.test(reference)) { resources[reference] = reference; continue; }
            const relativePath = localResourcePath(reference);
            if (!relativePath) throw new Error("不加载未纳管的外部图片");
            const asset = await readRelated(relativePath, signal);
            if (!asset.mime.startsWith("image/")) throw new Error("关联资源不是图片");
            resources[reference] = `data:${asset.mime};base64,${asset.base64}`;
          } catch (failure) { signal.throwIfAborted(); warnings.push(`${reference}：${message(failure)}`); }
        }
      } else if (kind === "html") {
        const prepared = await prepareStaticHtml(bytes, readRelated, signal);
        displayBytes = prepared.data; warnings.push(...prepared.warnings);
      }
      signal.throwIfAborted();
      if (live && assetCount > 0) {
        const verified = await projectFileApi.resolve(binding, object);
        signal.throwIfAborted();
        if (verified.state !== "ready" || verified.versionNumber !== version || verified.contentHash !== selected.contentHash || verified.relativePath !== live.relativePath) throw new Error(verified.reason ?? "文件在关联资源读取期间发生变化，请刷新。");
      }
      sourceCallback.current?.({ object: result.object, revision: result.contentHash, fileVersion: result.versionNumber, recordVersion: null, blockId: null, locator: null, title: result.name, excerpt: "" });
      const rendererId = ++rendererSequence.current;
      setLoaded(previous => {
        const sameHtml = previous?.kind === "html" && kind === "html" && previous.version === version && previous.contentHash === result.contentHash && previous.bytes?.byteLength === displayBytes.byteLength && previous.bytes.every((byte, index) => byte === displayBytes[index]);
        return { name: live?.name ?? result.name, renderName: result.name, kind, text, resources, warnings, bytes: kind === "image" || kind === "pdf" || kind === "html" ? (sameHtml ? previous.bytes : displayBytes) : undefined, version, contentHash: result.contentHash, rendererId: sameHtml ? previous.rendererId : rendererId, versions, signal };
      });
    })().catch(failure => { if (!signal.aborted) { setLoaded(undefined); setError(message(failure)); sourceCallback.current?.(null); } }).finally(() => { if (!signal.aborted) setReading(false); });
    return () => { lifetime.abort(); dependentIds.current.clear(); sourceCallback.current?.(null); };
  }, [workspaceRoot, projectId, fileId, selection, reload, visible]);
  const valid = loaded && (!loaded.signal.aborted || (loaded.kind === "html" && !source)) && (selection === undefined || loaded.version === selection) && (versionNumber === lastRequested.current || versionNumber === undefined || loaded.version === versionNumber) ? loaded : undefined;
  const showSource = source && (valid?.kind === "html" || valid?.kind === "markdown");
  function viewChanged(partial: ProjectFileView) {
    if (!valid) return;
    views.current.set(valid.version, { ...initialView, ...views.current.get(valid.version), ...partial });
    callbacks.current?.(partial);
  }
  function choose(value: number | undefined) { sourceCallback.current?.(null); setSelection(value); callbacks.current?.({ versionNumber: value, sourceLocator: undefined, line: undefined, page: undefined }); }
  return <section className="project-file-content" hidden={!visible} data-focused={focused || undefined} aria-label="项目文件预览">
    <header className="project-file-content__toolbar">
      <strong>{valid?.name ?? "文件"}</strong>
      <label>版本<select aria-label="文件查看版本" value={selection ?? "latest"} onChange={event => choose(event.target.value === "latest" ? undefined : Number(event.target.value))}>
        <option value="latest">最新版本</option>{availableVersions.map(item => <option key={item.id} value={item.versionNumber}>v{item.versionNumber}</option>)}
        {selection !== undefined && !availableVersions.some(item => item.versionNumber === selection) ? <option value={selection}>v{selection} · 固定</option> : null}
      </select></label>
      {valid ? <span>{`v${valid.version}${selection !== undefined ? " · 固定版本" : " · 最新已登记版本"}`}</span> : null}
      <button type="button" disabled={reading} onClick={() => { sourceCallback.current?.(null); setReload(value => value + 1); }}>刷新</button>
      {valid && (valid.kind === "markdown" || valid.kind === "html") ? <button type="button" aria-pressed={source} onClick={() => { const next = !source; setSource(next); callbacks.current?.({ sourceMode: next }); }}>{source ? (valid.kind === "html" ? "静态预览" : "预览") : "源码 / 行定位"}</button> : null}
      {valid?.text !== undefined ? <button type="button" onClick={() => void navigator.clipboard.writeText(valid.text!).catch(failure => setError(message(failure)))}>复制完整源码</button> : null}
    </header>
    {error ? <p role="alert">{error}</p> : null}
    {reading && visible ? <p role="status">正在读取固定版本…</p> : null}
    {valid?.kind === "html" ? <p className="project-file-content__notice">静态 HTML 预览：脚本、导航与表单提交已禁用，不提供交互执行。复杂 CSS 依赖未递归加载。</p> : null}
    {valid?.kind === "html" && !source ? <p className="project-file-content__notice">静态预览隐藏后保留当前位置；关闭重开、内容变化或应用重启后无法恢复内部位置。源码视图支持位置恢复。</p> : null}
    {valid && sourceLocator?.kind === "paragraph" ? <p className="project-file-content__notice">引用提取段落 {sourceLocator.start}–{sourceLocator.end}。此定位不是源码行号，当前显示对应固定版本全文。</p> : null}
    {valid && sourceLocator?.kind === "page" ? <p className="project-file-content__notice">已定位到第 {sourceLocator.page} 页；引用的页内字符范围 {sourceLocator.start}–{sourceLocator.end} 暂不支持高亮。</p> : null}
    {valid?.kind === "markdown" && line !== undefined && !source ? <p className="project-file-content__notice">行定位请使用源码视图。</p> : null}
    {valid?.warnings.map(warning => <p key={warning} role="status" className="project-file-content__notice">未加载资源：{warning}</p>)}
    <div className="project-file-content__body">
      {valid?.kind === "unsupported" ? <p role="status">此格式暂不支持应用内预览或编辑；文件身份和版本仍保留。请从项目文件菜单在本地打开原件。</p>
        : valid ? <DshFilePreview key={`${valid.version}:${valid.rendererId}:${valid.kind}:${showSource}`} kind={showSource ? "text" : valid.kind} name={valid.renderName} text={valid.text} bytes={showSource ? undefined : valid.bytes} resources={valid.resources} signal={valid.signal} line={line} page={page} initialView={initialView || views.current.has(valid.version) ? { ...initialView, ...views.current.get(valid.version) } : undefined} onViewChange={viewChanged} /> : null}
    </div>
  </section>;
}
