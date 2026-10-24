import { fileOwnerScope, sameFileOwner } from "../../lib/file-types";
import { EditorLoading } from "./EditorLoading";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Code2, Eye, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryKeys";
import type { AgentObjectRef, AgentSourceRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { FileVersionMetadata } from "../../lib/file-types";
import { readCompleteFileSource } from "../../lib/file-source";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { agentApi, AgentApiError } from "../../services/agentApi";
import { desktopApi } from "../../services/desktopApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileBytes, projectFileApi } from "../../services/projectFileApi";
import { markdownImageReferences, localResourcePath } from "../../../packages/dsh-ui/preview/resources.mjs";
import { HtmlWebviewContent } from "./HtmlWebviewContent";
import { DshFilePreview, type DshPreviewKind } from "../../../packages/dsh-ui/preview";
import { FileOpenWithButton } from "./FileOpenWithButton";
import { FileVersionMenu } from "./FileVersionMenu";
import "./project-file-content.css";
const MarkdownFileContent = lazy(() => import("./MarkdownFileContent").then(module => ({default:module.MarkdownFileContent})));
import {loadOfficeHost, preloadOfficeComponents} from "../office/office-component-loader";

export interface ProjectFileView { versionNumber?: number; line?: number; page?: number; scrollTop?: number; zoom?: number; sourceLocator?: NonNullable<AgentSourceRef["locator"]>; sourceMode?: boolean }
export interface ProjectFileContentProps {
  workspaceRoot: string; projectId: number | null; fileId: number; versionNumber?: number; line?: number; page?: number;
  fileName?: string;
  /** View for the selected File version; zoom 0 means fit width. */
  initialView?: { scrollTop?: number; zoom?: number };
  initialSourceMode?: boolean;
  sourceLocator?: NonNullable<AgentSourceRef["locator"]>;
  toolbarActions?: ReactNode;
  identityRecovery?: ReactNode;
  registerCloseGuard?: (guard: () => Promise<void>) => () => void;
  onSourceReady?: (source: AgentSourceRef | null) => void;
  visible: boolean; focused: boolean; onViewChange?: (partialView: ProjectFileView) => void;
}
type Kind = DshPreviewKind | "html" | "office" | "unsupported";
export function projectFilePreviewKind(name: string, mime: string): Kind {
  if (/\.html?$/iu.test(name) || mime === "text/html") return "html";
  if (/\.md(?:own|arkdown)?$/iu.test(name)) return "markdown";
  if (/\.pdf$/iu.test(name) || mime === "application/pdf") return "pdf";
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/iu.test(name)) return "image";
  if (/\.(docx|xlsx|pptx)$/iu.test(name)) return "office";
  if (/\.(docx?|xlsx?|pptx?|zip|exe|bin|mp[34]|mov|wav|woff2?|ttf)$/iu.test(name)) return "unsupported";
  if (/\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|css|scss|json|toml|ya?ml|sql|xml)$/iu.test(name)) return "code";
  if (/^(text\/|application\/(json|xml))/u.test(mime) || /\.(txt|log|csv)$/iu.test(name) || /^(readme|license)$/iu.test(name)) return "text";
  return "unsupported";
}
interface Loaded { resolveResource?: (reference:string) => Promise<string|undefined>; binding: AgentWorkspaceBinding; object: AgentObjectRef; resources: Record<string,string>; warnings:string[]; name: string; renderName: string; kind: Kind; text?: string; bytes?: Uint8Array; version: number; contentHash: string; rendererId: number; reload: number; versions: FileVersionMetadata[]; signal: AbortSignal }
function sameObject(a: AgentObjectRef, b: AgentObjectRef) {
  return a?.workspaceId === b.workspaceId && a.id === b.id && a.kind === b.kind && sameFileOwner(a.scope, b.scope);
}
function message(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}
/** The object is the component identity; versions are viewing state within that object. */
export function ProjectFileContent(props: ProjectFileContentProps) {
  return <FileContent key={`${props.workspaceRoot}:${props.projectId}:${props.fileId}`} {...props} />;
}
function FileContent({ workspaceRoot, projectId, fileId, fileName, versionNumber, line, page, sourceLocator, initialView, initialSourceMode, visible, focused, onViewChange, onSourceReady, toolbarActions, identityRecovery, registerCloseGuard }: ProjectFileContentProps) {
  const queryClient = useQueryClient();
  const [OfficeFileContent, setOfficeFileContent] = useState<typeof import('../office/OfficeFileContent').OfficeFileContent>();
  const [officeHostError, setOfficeHostError] = useState<string>();
  const editorFlush = useRef<(() => Promise<void>) | null>(null);
  const editorDirty = useRef(false);
  const editorEditRevision = useRef(0);
  const discardCloseRevision = useRef<number | undefined>(undefined);
  const pendingEditorClose = useRef<Promise<void> | null>(null);
  const editorContext = useRef<Loaded | undefined>(undefined);
  const resourceLifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const lifetime = new AbortController(); resourceLifetime.current = lifetime;
    return () => lifetime.abort();
  }, []);
  const [editorMenu,setEditorMenu] = useState<HTMLSpanElement | null>(null);
  const [editorToolbar,setEditorToolbar] = useState<HTMLSpanElement | null>(null);
  const registerEditorFlush = useCallback((flush: () => Promise<void>) => {
    editorFlush.current = flush;
    return () => { if (editorFlush.current === flush) editorFlush.current = null; };
  }, []);
  const flushEditor = useCallback(async () => { if (editorFlush.current) await editorFlush.current(); }, []);
  useEffect(() => registerCloseGuard?.(() => {
    if (pendingEditorClose.current) return pendingEditorClose.current;
    const pending = (async () => {
      const context = editorContext.current;
      const checkBinding = async () => {
        const current = (await agentApi.statusGet()).binding;
        if (!context || !current || current.workspaceId !== context.binding.workspaceId || current.generation !== context.binding.generation
          || editorContext.current?.binding.workspaceId !== context.binding.workspaceId || editorContext.current?.binding.generation !== context.binding.generation) {
          throw new Error("工作区已切换，关闭已取消");
        }
      };
      if (discardCloseRevision.current === editorEditRevision.current) {
        const revision = editorEditRevision.current;
        await checkBinding();
        if (revision !== editorEditRevision.current) throw new Error("文件内容已变化，请重新确认关闭");
        return;
      }
      try { if (editorFlush.current) await editorFlush.current(); }
      catch (failure) {
        if (!context || !(failure instanceof AgentApiError)) throw failure;
        const missingOriginal = failure.code === "SOURCE_NOT_READY" && typeof failure.details === "object" && failure.details !== null
          && "reason" in failure.details && failure.details.reason === "original_missing";
        if (failure.code === "NOT_FOUND") {
          // A save's NOT_FOUND may refer to an internal reference/version. This
          // native list resolves the target itself, without requiring a version.
          let targetMissing = false;
          try { await fileDocumentApi.versionsList(context.binding, { object: context.object, limit: 1 }); }
          catch (lookupFailure) {
            if (!(lookupFailure instanceof AgentApiError) || lookupFailure.code !== "NOT_FOUND") throw lookupFailure;
            targetMissing = true;
          }
          if (!targetMissing) throw failure;
        } else if (failure.code !== "OBJECT_WITHDRAWN" && !missingOriginal) throw failure;
        const revision = editorEditRevision.current;
        if (!await desktopApi.confirm("原始文件已删除/不可用，关闭会丢失未保存修改")) throw failure;
        await checkBinding();
        if (revision !== editorEditRevision.current) throw failure;
        discardCloseRevision.current = revision;
      }
    })();
    pendingEditorClose.current = pending.finally(() => { pendingEditorClose.current = null; });
    return pendingEditorClose.current;
  }), [registerCloseGuard]);

  const views = useRef(new Map<number, ProjectFileView>());
  const dependentIds = useRef(new Set<number>());
  const [selection, setSelection] = useState(versionNumber);
  const [reload, setReload] = useState(0);
  const [availableVersions, setAvailableVersions] = useState<FileVersionMetadata[]>([]);
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [needsRecovery, setNeedsRecovery] = useState(false);
  const [opening, setOpening] = useState(false);
  const externalRequest = useRef<AbortController | null>(null);
  const [reading, setReading] = useState(false);
  const [source, setSource] = useState(initialSourceMode ?? false);
  const lastSourceMode = useRef(initialSourceMode);
  const sourceMode = useRef(source); sourceMode.current = source;
  const rendererSequence = useRef(0);
  const callbacks = useRef(onViewChange); callbacks.current = onViewChange;
  const sourceCallback = useRef(onSourceReady); sourceCallback.current = onSourceReady;
  const lastRequested = useRef(versionNumber);
  useEffect(() => {
    setOpening(false);
    return () => { externalRequest.current?.abort(); externalRequest.current = null; };
  }, [visible]);
  useEffect(() => {
    if (initialSourceMode !== lastSourceMode.current) {
      lastSourceMode.current = initialSourceMode;
      if (initialSourceMode !== undefined) setSource(initialSourceMode);
    }
  }, [initialSourceMode]);
  useEffect(() => {
    if (!visible && source) setLoaded(previous => previous?.kind === "office" || previous?.kind === "markdown" ? previous : undefined);
  }, [visible, source]);
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    const key = event.query.queryKey;
    if (!editorDirty.current && selection === undefined && event.type === "updated" && event.action.type === "invalidate" && key[0] === queryKeys.documentVersions(fileId)[0] && (key[1] === fileId || dependentIds.current.has(Number(key[1])))) setReload(value => value + 1);
  }), [queryClient, selection, fileId]);
  // A parent view update acknowledges local version choices without resetting other view state.
  useEffect(() => {
    if (lastRequested.current !== versionNumber) { lastRequested.current = versionNumber; setSelection(versionNumber); }
  }, [versionNumber]);
  useEffect(() => {
    dependentIds.current.clear();
    sourceCallback.current?.(null);
    const retainEditorOrHtml = (previous: Loaded | undefined) => (previous?.kind === "office" || previous?.kind === "markdown" || (previous?.kind === "html" && !sourceMode.current)) && (selection === undefined || previous.version === selection) ? previous : undefined;
    if (editorDirty.current && selection === undefined) { setReading(false); return; }
    if (!visible) { setLoaded(retainEditorOrHtml); setReading(false); return; }
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    setLoaded(retainEditorOrHtml); setError(undefined); setReading(true);
    function prepareOffice(name?: string) {
      if (!name || projectFilePreviewKind(name, '') !== 'office') return;
      preloadOfficeComponents(name);
      void loadOfficeHost().then(module => {
        if (!signal.aborted) setOfficeFileContent(() => module.OfficeFileContent);
      }, failure => {if (!signal.aborted) setOfficeHostError(message(failure));});
    }
    prepareOffice(fileName);
    void (async () => {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      signal.throwIfAborted();
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: fileOwnerScope(projectId), kind: "file", id: String(fileId) };
      const live = selection === undefined ? await projectFileApi.resolve(binding, object) : undefined;
      signal.throwIfAborted();
      prepareOffice(live?.name);
      if (live && !sameObject(live.object, object)) throw new Error("当前文件所属项目不符。");
      if (live) setNeedsRecovery(live.state !== "ready");
      if (live) setLoaded(previous => (previous?.kind === "office" || previous?.kind === "markdown") ? retainEditorOrHtml(previous) : previous?.kind === "html" && live.state === "ready" && previous.version === live.versionNumber && previous.contentHash === live.contentHash ? previous : undefined);
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
      setLoaded(previous => (previous?.kind === "office" || previous?.kind === "markdown") ? retainEditorOrHtml(previous) : previous?.kind === "html" && previous.version === version && previous.contentHash === selected.contentHash ? previous : undefined);
      const input = { object, versionNumber: version, expectedContentHash: selected.contentHash };
      // The Office command reads and verifies the fixed original natively.
      // Avoid the generic 10 MiB preview read and a second base64 round trip.
      if (projectFilePreviewKind(selected.name, "") === "office") {
        prepareOffice(selected.name);
        if (editorDirty.current && selection === undefined) return;
        sourceCallback.current?.({object,revision:selected.contentHash,fileVersion:version,recordVersion:null,blockId:null,locator:null,title:selected.name,excerpt:""});
        setLoaded({binding,object,name:live?.name ?? selected.name,renderName:selected.name,kind:"office",resources:{},warnings:[],version,contentHash:selected.contentHash,rendererId:++rendererSequence.current,reload,versions,signal});
        return;
      }
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
          if (!sameFileOwner(related.object.scope, object.scope) || related.object.workspaceId !== binding.workspaceId || related.versionNumber !== resolved.versionNumber || related.contentHash !== resolved.contentHash || !sameObject(related.object, resolved.object)) throw new Error("关联资源所属项目或版本不符");
          dependentIds.current.add(Number(related.object.id));
          const actual = fileBytes(related);
          if (actual.byteLength !== related.byteLength) throw new Error("关联资源字节不完整");
          if (related.byteLength > 4 * 1024 * 1024 || (totalBytes += related.byteLength) > 32 * 1024 * 1024) throw new Error("关联资源超过预览字节预算");
          return related;
        })();
        resourceCache.set(relativePath, pending); return pending;
      };
      const resolveMarkdownImage = async (reference: string, resourceSignal: AbortSignal) => {
        resourceSignal.throwIfAborted();
        if (/^data:image\//iu.test(reference)) return reference;
        const relativePath = localResourcePath(reference);
        if (!relativePath) throw new Error("不加载未纳管的外部图片");
        const asset = await readRelated(relativePath, resourceSignal);
        if (!asset.mime.startsWith("image/")) throw new Error("关联资源不是图片");
        return `data:${asset.mime};base64,${asset.base64}`;
      };
      if (kind === "markdown") {
        for (const reference of markdownImageReferences(text!)) {
          try {
            resources[reference] = await resolveMarkdownImage(reference, signal);
          } catch (failure) { signal.throwIfAborted(); warnings.push(`${reference}：${message(failure)}`); }
        }
      }
      signal.throwIfAborted();
      if (live && assetCount > 0) {
        const verified = await projectFileApi.resolve(binding, object);
        signal.throwIfAborted();
        if (verified.state !== "ready" || verified.versionNumber !== version || verified.contentHash !== selected.contentHash || verified.relativePath !== live.relativePath) throw new Error(verified.reason ?? "文件在关联资源读取期间发生变化，请刷新。");
      }
      // Editing can begin while a retained editor is revalidated.
      // Its fixed baseline must survive that asynchronous read until CAS save.
      if (editorDirty.current && selection === undefined) return;
      sourceCallback.current?.({ object: result.object, revision: result.contentHash, fileVersion: result.versionNumber, recordVersion: null, blockId: null, locator: null, title: result.name, excerpt: "" });
      const rendererId = ++rendererSequence.current;
      const resolveResource = kind === "markdown" && selection === undefined ? async (reference: string) => {
        const resourceSignal = resourceLifetime.current!.signal;
        resourceSignal.throwIfAborted();
        const image = await resolveMarkdownImage(reference, resourceSignal);
        const current = await projectFileApi.resolve(binding, object);
        resourceSignal.throwIfAborted();
        if (current.state !== "ready" || !sameObject(current.object, object) || current.relativePath !== live!.relativePath) throw new Error("文件位置在关联资源读取期间发生变化，请刷新。");
        return image;
      } : undefined;
      setLoaded(previous => {
        const sameHtml = previous?.kind === "html" && kind === "html" && previous.version === version && previous.contentHash === result.contentHash && previous.reload === reload && previous.binding.workspaceId === binding.workspaceId && previous.binding.generation === binding.generation;
        return { binding, object: result.object, name: live?.name ?? result.name, renderName: result.name, kind, text, resources, resolveResource, warnings, bytes: kind === "image" || kind === "pdf" ? bytes : undefined, version, contentHash: result.contentHash, rendererId: sameHtml ? previous.rendererId : rendererId, reload, versions, signal };
      });
    })().catch(failure => { if (!signal.aborted) { if (!editorDirty.current) setLoaded(undefined); setError(message(failure)); sourceCallback.current?.(null); } }).finally(() => { if (!signal.aborted) setReading(false); });
    return () => { lifetime.abort(); dependentIds.current.clear(); sourceCallback.current?.(null); };
  }, [workspaceRoot, projectId, fileId, selection, reload, visible]);
  const valid = loaded && (!loaded.signal.aborted || ((loaded.kind === "html" && !source) || loaded.kind === "office" || loaded.kind === "markdown")) && (selection === undefined || loaded.version === selection) && (versionNumber === lastRequested.current || versionNumber === undefined || loaded.version === versionNumber) ? loaded : undefined;
  editorContext.current = valid?.kind === "office" || valid?.kind === "markdown" ? valid : undefined;
  const showSource = source && (valid?.kind === "html" || valid?.kind === "markdown");
  function viewChanged(partial: ProjectFileView) {
    if (!valid) return;
    if (partial.sourceMode !== undefined) setSource(partial.sourceMode);
    views.current.set(valid.version, { ...initialView, ...views.current.get(valid.version), ...partial });
    callbacks.current?.(partial);
  }
  async function choose(value: number | undefined) {
    try { if (editorFlush.current) await editorFlush.current(); sourceCallback.current?.(null); setSelection(value); callbacks.current?.({ versionNumber: value, sourceLocator: undefined, line: undefined, page: undefined }); }
    catch (failure) { setError(message(failure)); }
  }
  async function refresh() {
    try { if (editorFlush.current) await editorFlush.current(); sourceCallback.current?.(null); setReload(value => value + 1); }
    catch (failure) { setError(message(failure)); }
  }
  function editorSaved(version: number, contentHash: string, text?: string) {
    setLoaded(previous => previous ? {...previous, version, contentHash, ...(text !== undefined ? {text} : {})} : previous);
    if (valid) sourceCallback.current?.({object: valid.object, revision: contentHash, fileVersion: version, recordVersion: null, blockId: null, locator: null, title: valid.name, excerpt: ""});
    void fileDocumentApi.versionsList(valid!.binding, {object: valid!.object, limit:50}).then(result => setAvailableVersions(result.versions)).catch(failure => setError(message(failure)));
  }

  async function openExternal() {
    if (!visible || externalRequest.current) return;
    const controller = new AbortController(); externalRequest.current = controller;
    setOpening(true); setError(undefined);
    try {
      if (editorFlush.current) await editorFlush.current();
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      controller.signal.throwIfAborted();
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: fileOwnerScope(projectId), kind: "file", id: String(fileId) };
      await projectFileApi.openLocal(binding, object);
      controller.signal.throwIfAborted();
    } catch (failure) { if (!controller.signal.aborted) setError(message(failure)); }
    finally { if (!controller.signal.aborted) { externalRequest.current = null; setOpening(false); } }
  }
  return <section className="project-file-content" hidden={!visible} data-focused={focused || undefined} aria-label={projectId === null ? "工作区文件预览" : "项目文件预览"}>
    <header className="project-file-content__toolbar">
      {(valid?.kind === "office" || valid?.kind === "markdown") ? <span ref={setEditorMenu} className="project-file-content__file-menu" /> : null}
      <strong title={valid?.name}>{valid?.name ?? "文件"}</strong>
      <FileVersionMenu label="文件查看版本" triggerLabel={selection === undefined ? (valid ? `v${valid.version}` : "版本") : `v${selection}`}
        versions={availableVersions.some(item => item.versionNumber === selection) || selection === undefined ? availableVersions : [...availableVersions, { id: String(selection), versionNumber: selection }]}
        selectedVersion={selection} includeLatest latestVersion={selection === undefined ? valid?.version : availableVersions.find(item => item.isCurrent)?.versionNumber}
        visible={visible} onSelect={choose} />
      {valid?.kind === "html" ? <button type="button" className="project-file-content__icon-button" aria-label={source ? "网页" : "源码 / 行定位"} title={source ? "返回网页" : "查看原始源码 / 行定位"} aria-pressed={source} onClick={() => { const next = !source; setSource(next); callbacks.current?.({ sourceMode: next }); }}>{source ? <Eye size={14} aria-hidden="true" /> : <Code2 size={14} aria-hidden="true" />}</button> : null}
      {(valid?.kind === "office" || valid?.kind === "markdown") ? <span ref={setEditorToolbar} className="project-file-content__office-actions" /> : null}
      <button type="button" className="project-file-content__icon-button" aria-label="刷新" title="刷新当前查看版本" disabled={reading} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" /></button>
      <FileOpenWithButton workspaceRoot={workspaceRoot} projectId={projectId} fileId={fileId} fileName={fileName} visible={visible} beforeOpen={flushEditor}
        onOpen={() => void openExternal()} opening={opening}
        title={selection !== undefined ? "在外部应用打开当前原件（不随固定版本切换）" : undefined} />
      {toolbarActions}
    </header>
    {needsRecovery ? identityRecovery : null}
    {error ? <p role="alert">{error}</p> : null}
    {reading && visible && valid ? <p role="status">正在读取固定版本…</p> : null}
    {valid?.kind === "html" && !source ? <p className="project-file-content__notice">网页可交互与联网；隐藏保留状态，刷新或切换源码/版本会重新加载。</p> : null}
    {valid?.kind === "html" && !source && selection !== undefined ? <p className="project-file-content__notice">历史版本缺少依赖快照时，相关资源无法加载。</p> : null}
    {valid && sourceLocator?.kind === "paragraph" ? <p className="project-file-content__notice">引用提取段落 {sourceLocator.start}–{sourceLocator.end}。此定位不是源码行号，当前显示对应固定版本全文。</p> : null}
    {valid && sourceLocator?.kind === "page" ? <p className="project-file-content__notice">已定位到第 {sourceLocator.page} 页；引用的页内字符范围 {sourceLocator.start}–{sourceLocator.end} 暂不支持高亮。</p> : null}
    {valid?.warnings.map(warning => <p key={warning} role="status" className="project-file-content__notice">未加载资源：{warning}</p>)}
    <div className="project-file-content__body">
      {!valid && reading && visible ? <EditorLoading fileName={fileName} stage="resolve" /> : valid?.kind === "unsupported" ? <p role="status">此格式暂不支持应用内预览或编辑；文件身份和版本仍保留。可使用工具栏在外部应用打开当前原件。</p>
        : valid?.kind === "office" ? (officeHostError ? <p role="alert">{officeHostError}</p> : OfficeFileContent ? <OfficeFileContent fileName={valid.renderName} toolbar={editorToolbar} menuToolbar={editorMenu} binding={valid.binding} baseline={{object:valid.object,versionNumber:valid.version,expectedContentHash:valid.contentHash}} readOnly={selection !== undefined} registerFlush={registerEditorFlush} onDirtyChange={dirty => {editorDirty.current = dirty; editorEditRevision.current++;}} onSaved={editorSaved} /> : <EditorLoading fileName={valid.renderName} stage="runtime" />)
        : valid?.kind === "markdown" ? <Suspense fallback={<EditorLoading format="markdown" stage="runtime" />}><MarkdownFileContent toolbar={editorToolbar} menuToolbar={editorMenu} binding={valid.binding} baseline={{object:valid.object,versionNumber:valid.version,expectedContentHash:valid.contentHash}} text={valid.text!} resources={valid.resources} resolveResource={valid.resolveResource} line={line} sourceMode={source} initialView={initialView || views.current.has(valid.version) ? {...initialView,...views.current.get(valid.version)} : undefined} onViewChange={viewChanged} readOnly={selection !== undefined} registerFlush={registerEditorFlush} onDirtyChange={dirty=>{editorDirty.current=dirty; editorEditRevision.current++;}} onSaved={editorSaved}/></Suspense>
        : valid?.kind === "html" && !showSource ? <HtmlWebviewContent key={`${valid.version}:${valid.rendererId}`} binding={valid.binding} input={{object:valid.object,versionNumber:valid.version,expectedContentHash:valid.contentHash}} historical={selection !== undefined} visible={visible} />
        : valid ? <DshFilePreview key={`${valid.version}:${valid.rendererId}:${valid.kind}:${showSource}`} kind={showSource ? "text" : valid.kind} name={valid.renderName} text={valid.text} bytes={showSource ? undefined : valid.bytes} resources={valid.resources} signal={valid.signal} line={line} page={page} initialView={initialView || views.current.has(valid.version) ? { ...initialView, ...views.current.get(valid.version) } : undefined} onViewChange={viewChanged} /> : null}
    </div>
  </section>;
}
