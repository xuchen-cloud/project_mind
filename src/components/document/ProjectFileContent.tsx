import {useFeedbackStore} from "../../state/feedback-store";
import { fileOwnerScope, sameFileOwner } from "../../lib/file-types";
import { EditorLoading } from "./EditorLoading";
import { lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ProjectContentMoveContext } from "../../lib/project-content-move-context";
import { registerFileEditor } from "../../lib/file-editor-registration";
import { subscribeFileReplaced, type FileReplaced } from "../../lib/content-owner-move-events";
import { hasPendingContentOwnerMove, registerContentOwnerMoveParticipant } from "../../lib/project-content-lifecycle";
import { Code2, Eye, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryKeys";
import type { AgentObjectRef, AgentSourceRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { FileVersionMetadata } from "../../lib/file-types";
import { readCompleteFileSource } from "../../lib/file-source";
import {fileWorkingApi, type FileWorkingOpen, type FileWorkingStatus} from "../../services/fileWorkingApi";
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
  identityRecovery?: (onRecovered: () => void) => ReactNode;
  registerCloseGuard?: (close: () => Promise<void>, strictSave?: () => Promise<void>) => () => void;
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
interface Loaded { working?:FileWorkingOpen; resourceController?: AbortController; resolveResource?: (reference:string) => Promise<string|undefined>; binding: AgentWorkspaceBinding; object: AgentObjectRef; resources: Record<string,string>; warnings:string[]; name: string; renderName: string; kind: Kind; text?: string; bytes?: Uint8Array; version: number; contentHash: string; rendererId: number; reload: number; versions: FileVersionMetadata[]; signal: AbortSignal }
function sameObject(a: AgentObjectRef, b: AgentObjectRef) {
  return a?.workspaceId === b.workspaceId && a.id === b.id && a.kind === b.kind && sameFileOwner(a.scope, b.scope);
}
function sameBinding(a: AgentWorkspaceBinding | undefined, b: AgentWorkspaceBinding | undefined) {
  return !!a && !!b && a.workspaceId === b.workspaceId && a.generation === b.generation;
}
function editorIdentity(context: Loaded) {
  return JSON.stringify([context.binding.workspaceId, context.binding.generation, context.object,
    context.working?.sessionId ?? [context.version, context.contentHash]]);
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
  const contentMove = useContext(ProjectContentMoveContext);
  const queryClient = useQueryClient();
  const [OfficeFileContent, setOfficeFileContent] = useState<typeof import('../office/OfficeFileContent').OfficeFileContent>();
  const [officeHostError, setOfficeHostError] = useState<string>();
  const editorFlush = useRef<(() => Promise<void>) | null>(null);
  const editorReady = useRef<string | undefined>(undefined);
  const [editorBinding, setEditorBinding] = useState<AgentWorkspaceBinding>();
  const activeBinding = useRef<AgentWorkspaceBinding | undefined>(undefined);
  // A committed replacement can leave a hidden page with no editor or session.
  // Initial/unready pages never acquire this acknowledgement.
  const retiredHead = useRef<{ binding: AgentWorkspaceBinding; object: AgentObjectRef } | undefined>(undefined);
  const hiddenReadonlyHead = useRef<{ binding: AgentWorkspaceBinding; object: AgentObjectRef } | undefined>(undefined);
  const [registrationError, setRegistrationError] = useState<string>();
  const [registeredBinding, setRegisteredBinding] = useState<AgentWorkspaceBinding>();
  const [registrationAttempt, setRegistrationAttempt] = useState(0);
  const replacementOperations = useRef(new Map<string, ReturnType<typeof registerContentOwnerMoveParticipant>>());
  const editorDirty = useRef(false);
  const editorEditRevision = useRef(0);
  const discardCloseRevision = useRef<number | undefined>(undefined);
  const pendingEditorClose = useRef<Promise<void> | null>(null);
  const editorContext = useRef<Loaded | undefined>(undefined);
  const moveContext = useRef<Loaded | undefined>(undefined);
  const openedWorking = useRef<{binding:AgentWorkspaceBinding;opened:FileWorkingOpen}|undefined>(undefined);
  const latestLoaded = useRef<Loaded|undefined>(undefined);
  const replacedHandler = useRef<(event: FileReplaced) => Promise<void>>(async () => undefined);
  async function releaseWorking() {
    const current=openedWorking.current;
    if(!current)return;
    openedWorking.current=undefined;
    if(contentMove?.nativeSessionsClosed)return;
    await fileWorkingApi.close(current.binding,{object:current.opened.object,sessionId:current.opened.sessionId});
  }
  useEffect(()=>()=>{latestLoaded.current=undefined;activeBinding.current=undefined;void releaseWorking().catch(failure=>useFeedbackStore.getState().pushToast({tone:'error',title:'无法释放文件编辑会话',detail:message(failure)}));},[]);
  const [editorMenu,setEditorMenu] = useState<HTMLSpanElement | null>(null);
  const [editorToolbar,setEditorToolbar] = useState<HTMLSpanElement | null>(null);
  const registerEditorFlush = useCallback((flush: () => Promise<void>) => {
    editorFlush.current = flush;
    return () => { if (editorFlush.current === flush) { editorFlush.current = null; editorReady.current = undefined; } };
  }, []);
  const flushEditor = useCallback(async () => { if (editorFlush.current) await editorFlush.current(); }, []);
  const strictSave = useCallback(async () => {
    const context = moveContext.current;
    const inactiveHead = retiredHead.current ?? hiddenReadonlyHead.current;
    if (!context && inactiveHead && sameBinding(inactiveHead.binding, activeBinding.current)
      && !latestLoaded.current && !openedWorking.current && !editorFlush.current && !editorDirty.current) return;
    if (!context || !sameBinding(context.binding, activeBinding.current) || ((context.kind === "office" || context.kind === "markdown")
      && (!editorFlush.current || editorReady.current !== editorIdentity(context)))) {
      throw new AgentApiError({ code: "EDITOR_BUSY", message: "文件编辑器尚未就绪，请稍后移动", retryable: true });
    }
    if (editorFlush.current) await editorFlush.current();
    if (editorDirty.current) throw new Error("文件保存期间有新的修改，请完成保存后重试移动");
  }, []);
  useEffect(() => {
    if (!editorBinding) return;
    let disposed = false;
    let unregister: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    const replaced = new Set<string>();
    setRegisteredBinding(undefined);
    setRegistrationError(undefined);
    const object: AgentObjectRef = { workspaceId: editorBinding.workspaceId, scope: fileOwnerScope(projectId), kind: "file", id: String(fileId) };
    void (async () => {
      const stop = await subscribeFileReplaced(event => {
        if (disposed || event.binding.workspaceId !== editorBinding.workspaceId || event.binding.generation !== editorBinding.generation
          || !sameBinding(event.binding, activeBinding.current) || !sameObject(event.object, object)
          || !replacementOperations.current.has(event.operationId)
          || !hasPendingContentOwnerMove({binding:event.binding,operationId:event.operationId,source:event.object})) return;
        const key = JSON.stringify([event.binding.workspaceId, event.binding.generation, event.operationId,
          event.object.workspaceId, event.object.scope.kind, event.object.scope.kind === "project" ? event.object.scope.projectId : null, event.object.kind, event.object.id]);
        if (replaced.has(key)) return;
        replaced.add(key);
        const participant = replacementOperations.current.get(event.operationId)!;
        void replacedHandler.current(event).catch(failure => {
          if (!disposed) setError(`无法更新替换后的文件会话：${message(failure)}`);
        }).finally(() => {
          participant.complete();
          if (replacementOperations.current.get(event.operationId) === participant) replacementOperations.current.delete(event.operationId);
        });
      });
      if (disposed) { stop(); return; }
      unlisten = stop;
      const stopEditor = await registerFileEditor({ binding: editorBinding, object, editorId: crypto.randomUUID().replaceAll("-", ""), flush: strictSave,
        onMoveRequested: operationId => {
          if (disposed) return;
          const participant = registerContentOwnerMoveParticipant({binding:editorBinding,operationId,source:object});
          replacementOperations.current.get(operationId)?.dispose();
          replacementOperations.current.set(operationId, participant);
        } });
      if (disposed) stopEditor(); else { unregister = stopEditor; setRegisteredBinding(editorBinding); }
    })()
      .catch(failure => { if (!disposed) setRegistrationError(`暂时无法启用文件编辑：${message(failure)}`); });
    return () => {
      disposed = true;
      for (const participant of replacementOperations.current.values()) participant.dispose();
      replacementOperations.current.clear(); unregister?.(); unlisten?.();
    };
  }, [workspaceRoot, projectId, fileId, editorBinding?.workspaceId, editorBinding?.generation, strictSave, registrationAttempt]);
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
      try { if (editorFlush.current) await editorFlush.current(); if(editorDirty.current)throw new Error("文件保存期间有新的修改，请完成保存后重试关闭"); }
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
  }, strictSave), [registerCloseGuard, strictSave]);

  const views = useRef(new Map<number, ProjectFileView>());
  const dependentIds = useRef(new Set<number>());
  const [selection, setSelection] = useState(versionNumber);
  const [reload, setReload] = useState(0);
  const [availableVersions, setAvailableVersions] = useState<FileVersionMetadata[]>([]);
  const [loaded, setLoaded] = useState<Loaded>();
  latestLoaded.current=loaded;
  // A retained Markdown editor owns its resources across hide/revalidation;
  // replacing or unmounting that document ends all of its pending image reads.
  useEffect(() => () => loaded?.resourceController?.abort(), [loaded?.resourceController]);
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
  function isCurrentRenderer(context: Loaded | undefined, binding = context?.binding) {
    const current = latestLoaded.current;
    return sameBinding(binding, activeBinding.current) && current?.rendererId === context?.rendererId
      && (!current || (!!context && sameBinding(current.binding, context.binding) && sameObject(current.object, context.object)));
  }
  function publishWorkingSource(context: Loaded) {
    const working = context.working;
    if (working && !working.pendingArchive && context.versions.some(item => item.versionNumber === working.archivedVersionNumber && item.contentHash === working.contentHash)) {
      sourceCallback.current?.({object:context.object,revision:working.contentHash,fileVersion:working.archivedVersionNumber,recordVersion:null,blockId:null,locator:null,title:context.name,excerpt:""});
    }
  }
  // Keep an active observer even while a retained editor is hidden. Unlike a
  // one-shot invalidate action, every successful fetch rearms invalidation.
  const versionMetadataQuery = useQuery({
    queryKey: [...queryKeys.documentVersions(fileId), "content", workspaceRoot,
      editorBinding?.workspaceId, editorBinding?.generation, projectId, selection ?? null, loaded?.rendererId ?? null],
    enabled: !!loaded && sameBinding(loaded.binding, editorBinding),
    staleTime: Infinity,
    retry: false,
    initialData: loaded && sameBinding(loaded.binding, editorBinding) ? {
      object: loaded.object, currentVersionNumber: loaded.version, currentContentHash: loaded.contentHash,
      versions: loaded.versions, nextCursor: null,
    } : undefined,
    queryFn: async ({signal}) => {
      const context = loaded!;
      const { binding, object } = context;
      const history = await fileDocumentApi.versionsList(binding, {object,limit:50});
      signal.throwIfAborted();
      if (!sameObject(history.object, object)) throw new Error("文件版本所属项目不符。");
      let versions = history.versions;
      if (selection !== undefined && !versions.some(item => item.versionNumber === selection)) {
        const older = await fileDocumentApi.versionsList(binding, {object,cursor:selection+1,limit:1});
        signal.throwIfAborted();
        if (!sameObject(older.object, object)) throw new Error("历史版本所属项目不符。");
        versions = [...versions, ...older.versions.filter(item => item.versionNumber === selection)];
      }
      if (isCurrentRenderer(context)) {
        setAvailableVersions(versions);
        const retained = latestLoaded.current!;
        const next = {...retained,versions};
        latestLoaded.current = next; setLoaded(next); publishWorkingSource(next);
        if (selection === undefined) {
          if (retained.working) {
            const status = await fileWorkingApi.tick(binding,object);
            signal.throwIfAborted();
            if (isCurrentRenderer(context) && latestLoaded.current?.working) {
              if (status.revision === latestLoaded.current.working.revision && status.contentHash === latestLoaded.current.working.contentHash) acknowledgeWorkingStatus(context,status,false);
              else if (!editorDirty.current) setReload(value => value + 1);
            }
          } else if ((history.currentVersionNumber !== retained.version || history.currentContentHash !== retained.contentHash) && !editorDirty.current) setReload(value => value + 1);
        }
      }
      return {...history,versions};
    },
  });
  useEffect(() => {
    if (versionMetadataQuery.error) setError(message(versionMetadataQuery.error));
  }, [versionMetadataQuery.error]);
  async function refreshVersionMetadata(context = latestLoaded.current) {
    if (!context || !isCurrentRenderer(context)) return;
    await versionMetadataQuery.refetch();
  }
  replacedHandler.current = async event => {
    const previous = latestLoaded.current;
    const oldWorking = openedWorking.current;
    const retainSession = event.noChange && !event.oldSessionsClosed;
    if (!retainSession) openedWorking.current = undefined;
    if (!retainSession && selection === undefined) {
      // Commit the old renderer's unmount before releasing the native save barrier.
      // Session closure applies only to this captured session, never to its replacement.
      previous?.resourceController?.abort();
      externalRequest.current?.abort();
      flushSync(() => {
        sourceCallback.current?.(null);
        setLoaded(undefined);
        setReload(value => value + 1);
      });
      editorFlush.current = null;
      editorReady.current = undefined;
      editorDirty.current = false;
      discardCloseRevision.current = undefined;
      retiredHead.current = {binding:event.binding,object:event.object};
    }
    try {
      if (retainSession && previous?.working) {
        const status = await fileWorkingApi.tick(event.binding,event.object);
        if (!isCurrentRenderer(previous)) return;
        acknowledgeWorkingStatus(previous,status,false);
      }
      if (!retainSession && oldWorking && !event.oldSessionsClosed) {
        await fileWorkingApi.close(oldWorking.binding, { object: oldWorking.opened.object, sessionId: oldWorking.opened.sessionId });
      }
      if (retainSession || selection !== undefined) await refreshVersionMetadata(previous);
    } catch (failure) { if (isCurrentRenderer(previous)) setError(`无法更新替换后的文件会话：${message(failure)}`); }
  };
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
    if (event.type !== "updated" || event.action.type !== "invalidate" || key[0] !== queryKeys.documentVersions(fileId)[0] || (key[1] !== fileId && !dependentIds.current.has(Number(key[1])))) return;
    if(key[1]!==fileId && selection===undefined && !editorDirty.current)setReload(value=>value+1);
  }), [queryClient, selection, fileId]);
  // A parent view update acknowledges local version choices without resetting other view state.
  useEffect(() => {
    if (lastRequested.current !== versionNumber) { lastRequested.current = versionNumber; setSelection(versionNumber); }
  }, [versionNumber]);
  useEffect(() => {
    dependentIds.current.clear();
    sourceCallback.current?.(null);
    const retainEditorOrHtml = (previous: Loaded | undefined) => (previous?.kind === "office" || previous?.kind === "markdown" || (previous?.kind === "html" && !sourceMode.current)) && (selection === undefined || (!previous.working && previous.version === selection)) ? previous : undefined;
    if (editorDirty.current && selection === undefined) { setReading(false); return; }
    const retained=latestLoaded.current;
    if(selection===undefined && retained?.working && retained.reload===reload){
      if(visible&&!retained.working.pendingArchive&&retained.versions.some(item=>item.versionNumber===retained.working!.archivedVersionNumber&&item.contentHash===retained.working!.contentHash))sourceCallback.current?.({object:retained.object,revision:retained.working.contentHash,fileVersion:retained.working.archivedVersionNumber,recordVersion:null,blockId:null,locator:null,title:retained.name,excerpt:""});
      setReading(false);return;
    }
    if (!visible) {
      if (retained && !retained.working && retained.kind !== "office" && retained.kind !== "markdown"
        && !editorFlush.current && !editorDirty.current) hiddenReadonlyHead.current = {binding:retained.binding,object:retained.object};
      setLoaded(retainEditorOrHtml); setReading(false); return;
    }
    hiddenReadonlyHead.current = undefined;
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
      activeBinding.current = binding;
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: fileOwnerScope(projectId), kind: "file", id: String(fileId) };
      setEditorBinding(binding);
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
      let working:FileWorkingOpen|undefined;
      const currentKind=live?projectFilePreviewKind(live.name,""):undefined;
      if(selection===undefined&&(currentKind==="office"||currentKind==="markdown")){
        const opened=await fileWorkingApi.open(binding,object);
        if(signal.aborted){await fileWorkingApi.close(binding,{object,sessionId:opened.sessionId});signal.throwIfAborted();}
        if(!sameObject(opened.object,object)){await fileWorkingApi.close(binding,{object:opened.object,sessionId:opened.sessionId});throw new Error("当前内容所属项目不符。");}
        if(editorDirty.current){await fileWorkingApi.close(binding,{object,sessionId:opened.sessionId});return;}
        try{await releaseWorking();}catch(failure){await fileWorkingApi.close(binding,{object,sessionId:opened.sessionId});throw failure;}
        if(signal.aborted){await fileWorkingApi.close(binding,{object,sessionId:opened.sessionId});signal.throwIfAborted();}
        working=opened;openedWorking.current={binding,opened};
        if(currentKind==="office"){
          prepareOffice(opened.name);
          const archived=history.versions.find(item=>item.versionNumber===opened.archivedVersionNumber);
          sourceCallback.current?.(!opened.pendingArchive&&archived?.contentHash===opened.contentHash?{object,revision:opened.contentHash,fileVersion:opened.archivedVersionNumber,recordVersion:null,blockId:null,locator:null,title:opened.name,excerpt:""}:null);
          setLoaded({working:opened,binding,object,name:opened.name,renderName:opened.name,kind:"office",resources:{},warnings:[],version:opened.archivedVersionNumber,contentHash:opened.contentHash,rendererId:++rendererSequence.current,reload,versions:history.versions,signal});
          return;
        }
      }else if(openedWorking.current){await releaseWorking();signal.throwIfAborted();}
      const version = selection ?? working?.archivedVersionNumber ?? live!.versionNumber;
      let selected = working ? {id:String(version),versionNumber:version,name:working.name,createdAt:"",contentHash:working.contentHash,isCurrent:true} : history.versions.find(item => item.versionNumber === version);
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
      if (!working && live && (live.versionNumber !== history.currentVersionNumber || live.contentHash !== selected.contentHash)) throw new Error("文件在对账后发生变化，请刷新。");
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
      const result = working ? {object,name:working.name,mime:"text/markdown",base64:working.base64,byteLength:Uint8Array.from(atob(working.base64),c=>c.charCodeAt(0)).length,versionNumber:version,contentHash:working.contentHash} : await projectFileApi.readBytes(binding, input);
      signal.throwIfAborted();
      if (!sameObject(result.object, object) || result.versionNumber !== version || result.contentHash !== (working?.contentHash ?? selected.contentHash)) throw new Error("文件字节与请求的固定版本不一致。");
      const bytes = fileBytes(result);
      if (bytes.byteLength !== result.byteLength) throw new Error("文件字节不完整。");
      const kind = projectFilePreviewKind(result.name, result.mime);
      let text: string | undefined;
      // Native source pagination verifies the same immutable version/hash on every page.
      if (working) text = new TextDecoder("utf-8", {fatal:true,ignoreBOM:true}).decode(bytes);
      else if (kind === "text" || kind === "markdown" || kind === "html") text = (await readCompleteFileSource(binding, input, signal)).text;
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
      const initialImages = new Set<string>();
      if (kind === "markdown") {
        for (const reference of markdownImageReferences(text!)) {
          if (/^data:image\//iu.test(reference)) { resources[reference] = reference; continue; }
          try {
            if (selection !== undefined) throw new Error("此历史版本未保留关联资源快照");
            if (!localResourcePath(reference)) throw new Error("不加载未纳管的外部图片");
            initialImages.add(reference);
          } catch (failure) { warnings.push(`${reference}：${message(failure)}`); }
        }
      }
      signal.throwIfAborted();
      // Editing can begin while a retained editor is revalidated.
      // Its fixed baseline must survive that asynchronous read until CAS save.
      if (editorDirty.current && selection === undefined) return;
      if(working)sourceCallback.current?.(!working.pendingArchive&&history.versions.some(item=>item.versionNumber===working.archivedVersionNumber&&item.contentHash===working.contentHash)?{object,revision:working.contentHash,fileVersion:working.archivedVersionNumber,recordVersion:null,blockId:null,locator:null,title:working.name,excerpt:""}:null);
      else sourceCallback.current?.({ object: result.object, revision: result.contentHash, fileVersion: result.versionNumber, recordVersion: null, blockId: null, locator: null, title: result.name, excerpt: "" });
      const rendererId = ++rendererSequence.current;
      const resourceController = kind === "markdown" && selection === undefined ? new AbortController() : undefined;
      const resolveResource = resourceController ? async (reference: string) => {
        const resourceSignal = resourceController.signal;
        resourceSignal.throwIfAborted();
        const image = await resolveMarkdownImage(reference, resourceSignal);
        resourceSignal.throwIfAborted();
        const current = await projectFileApi.resolve(binding, object);
        resourceSignal.throwIfAborted();
        if (current.state !== "ready" || !sameObject(current.object, object) || current.relativePath !== live!.relativePath) throw new Error("文件位置在关联资源读取期间发生变化，请刷新。");
        if(initialImages.has(reference)){
          if(working){
            const status=await fileWorkingApi.tick(binding,object);resourceSignal.throwIfAborted();
            const retained=latestLoaded.current?.working;
            if(status.revision!==(retained?.sessionId===working.sessionId?retained.revision:working.revision)||status.contentHash!==(retained?.sessionId===working.sessionId?retained.contentHash:working.contentHash))throw new Error("文件在关联资源读取期间发生变化，请刷新。");
          }else if(current.versionNumber!==version||current.contentHash!==selected.contentHash)throw new Error("文件在关联资源读取期间发生变化，请刷新。");
        }
        return image;
      } : undefined;
      setLoaded(previous => {
        const sameHtml = previous?.kind === "html" && kind === "html" && previous.version === version && previous.contentHash === result.contentHash && previous.reload === reload && previous.binding.workspaceId === binding.workspaceId && previous.binding.generation === binding.generation;
        return { working,binding, object: result.object, name: live?.name ?? result.name, renderName: result.name, kind, text, resources, resolveResource, resourceController, warnings, bytes: kind === "image" || kind === "pdf" ? bytes : undefined, version, contentHash: result.contentHash, rendererId: sameHtml ? previous.rendererId : rendererId, reload, versions, signal };
      });
    })().catch(failure => { if (!signal.aborted) { if (!editorDirty.current) setLoaded(undefined); setError(message(failure)); sourceCallback.current?.(null); } }).finally(() => { if (!signal.aborted) setReading(false); });
    return () => { lifetime.abort(); dependentIds.current.clear(); sourceCallback.current?.(null); };
  }, [workspaceRoot, projectId, fileId, selection, reload, visible]);
  const valid = loaded && (!(loaded.kind==="office"||loaded.kind==="markdown")||(selection===undefined?!!loaded.working:!loaded.working)) && (!loaded.signal.aborted || ((loaded.kind === "html" && !source) || loaded.kind === "office" || loaded.kind === "markdown")) && (selection === undefined || loaded.version === selection) && (versionNumber === lastRequested.current || versionNumber === undefined || loaded.version === versionNumber) ? loaded : undefined;
  moveContext.current = valid;
  editorContext.current = valid?.kind === "office" || valid?.kind === "markdown" ? valid : undefined;
  function editorDirtyChanged(context: Loaded, dirty: boolean) {
    editorReady.current = editorIdentity(context);
    editorDirty.current = dirty;
    editorEditRevision.current++;
  }
  const showSource = source && (valid?.kind === "html" || valid?.kind === "markdown");
  function viewChanged(partial: ProjectFileView) {
    if (!valid) return;
    if (partial.sourceMode !== undefined) setSource(partial.sourceMode);
    views.current.set(valid.version, { ...initialView, ...views.current.get(valid.version), ...partial });
    callbacks.current?.(partial);
  }
  async function choose(value: number | undefined) {
    try { if (editorFlush.current) await editorFlush.current(); sourceCallback.current?.(null); setSelection(value); callbacks.current?.({ versionNumber: value, sourceLocator: undefined, line: undefined, page: undefined }); }
    catch (failure) { setError(message(failure)); throw failure; }
  }
  function acknowledgeWorkingStatus(current:Loaded,status:FileWorkingStatus,refreshMetadata=true){
    const retained=latestLoaded.current;
    if(!isCurrentRenderer(current)||!retained?.working||retained.working.sessionId!==current.working?.sessionId||retained.working.revision!==status.revision||retained.working.contentHash!==status.contentHash)return;
    const archiveChanged=retained.working.archivedVersionNumber!==status.archivedVersionNumber||retained.working.pendingArchive!==status.pendingArchive;
    const next={...retained,version:status.archivedVersionNumber,working:{...retained.working,...status}};
    latestLoaded.current=next;setLoaded(next);
    if(archiveChanged){
      if(refreshMetadata)void refreshVersionMetadata(next);
      else publishWorkingSource(next);
    }
  }
  async function refresh() {
    setReading(true);
    try {
      if(editorFlush.current)await editorFlush.current();
      const current=latestLoaded.current;
      if(current?.working){
        const status=await fileWorkingApi.tick(current.binding,current.object);
        const retained=latestLoaded.current;
        if(retained?.working?.sessionId!==current.working.sessionId)return;
        if(status.revision===retained.working.revision&&status.contentHash===retained.working.contentHash){acknowledgeWorkingStatus(current,status);return;}
      }
      sourceCallback.current?.(null);setReload(value=>value+1);
    }catch(failure){setError(message(failure));}
    finally{setReading(false);}
  }
  function editorSaved(version: number, contentHash: string, working?:FileWorkingStatus, text?: string) {
    const previous=latestLoaded.current;
    const next=previous?{...previous,version,contentHash,...(working&&previous.working?{working:{...previous.working,...working}}:{}),...(text!==undefined?{text}:{})}:previous;
    latestLoaded.current=next;setLoaded(next);
    // A working hash is not an immutable vN source reference. The reference
    // action must use the native snapshot boundary before attaching a source.
    if(working)sourceCallback.current?.(null);
    else if(valid)sourceCallback.current?.({object:valid.object,revision:contentHash,fileVersion:version,recordVersion:null,blockId:null,locator:null,title:valid.name,excerpt:""});
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
      {(valid?.kind === "office" || valid?.kind === "markdown") ? <span ref={setEditorMenu} inert={!sameBinding(registeredBinding, editorBinding)} className="project-file-content__file-menu" /> : null}
      <strong title={valid?.name}>{valid?.name ?? "文件"}</strong>
      <FileVersionMenu label="文件查看版本" triggerLabel={selection === undefined ? (valid?.working ? "当前内容" : valid ? `v${valid.version}` : "版本") : `v${selection}`}
        versions={availableVersions.some(item => item.versionNumber === selection) || selection === undefined ? availableVersions : [...availableVersions, { id: String(selection), versionNumber: selection }]}
        selectedVersion={selection} includeLatest latestLabel={valid?.kind === "office" || valid?.kind === "markdown" ? "当前内容" : undefined} latestVersion={selection === undefined ? valid?.version : availableVersions.find(item => item.isCurrent)?.versionNumber}
        visible={visible} onSelect={choose} />
      {valid?.kind === "html" ? <button type="button" className="project-file-content__icon-button" aria-label={source ? "网页" : "源码 / 行定位"} title={source ? "返回网页" : "查看原始源码 / 行定位"} aria-pressed={source} onClick={() => { const next = !source; setSource(next); callbacks.current?.({ sourceMode: next }); }}>{source ? <Eye size={14} aria-hidden="true" /> : <Code2 size={14} aria-hidden="true" />}</button> : null}
      {(valid?.kind === "office" || valid?.kind === "markdown") ? <span ref={setEditorToolbar} inert={!sameBinding(registeredBinding, editorBinding)} className="project-file-content__office-actions" /> : null}
      <button type="button" className="project-file-content__icon-button" aria-label="刷新" title="刷新当前查看版本" disabled={reading} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" /></button>
      <FileOpenWithButton workspaceRoot={workspaceRoot} projectId={projectId} fileId={fileId} fileName={fileName} visible={visible} beforeOpen={flushEditor}
        onOpen={() => void openExternal()} opening={opening}
        title={selection !== undefined ? "在外部应用打开当前原件（不随固定版本切换）" : undefined} />
      {toolbarActions}
    </header>
    {needsRecovery ? identityRecovery?.(() => setReload(value => value + 1)) : null}
    {error ? <p role="alert">{error}</p> : null}
    {registrationError ? <div><p role="alert">{registrationError}。正文暂不可编辑，草稿已保留。</p><button type="button" onClick={() => { setRegisteredBinding(undefined); setRegistrationAttempt(value => value + 1); }}>重试启用编辑</button></div> : null}
    {reading && visible && valid ? <p role="status">正在读取固定版本…</p> : null}
    {valid?.kind === "html" && !source ? <p className="project-file-content__notice">网页可交互与联网；隐藏保留状态，刷新或切换源码/版本会重新加载。</p> : null}
    {valid?.kind === "html" && !source && selection !== undefined ? <p className="project-file-content__notice">历史版本缺少依赖快照时，相关资源无法加载。</p> : null}
    {valid && sourceLocator?.kind === "paragraph" ? <p className="project-file-content__notice">引用提取段落 {sourceLocator.start}–{sourceLocator.end}。此定位不是源码行号，当前显示对应固定版本全文。</p> : null}
    {valid && sourceLocator?.kind === "page" ? <p className="project-file-content__notice">已定位到第 {sourceLocator.page} 页；引用的页内字符范围 {sourceLocator.start}–{sourceLocator.end} 暂不支持高亮。</p> : null}
    {valid?.warnings.map(warning => <p key={warning} role="status" className="project-file-content__notice">未加载资源：{warning}</p>)}
    <div className="project-file-content__body" inert={!sameBinding(registeredBinding, editorBinding)}>
      {!valid && reading && visible ? <EditorLoading fileName={fileName} stage="resolve" /> : valid?.kind === "unsupported" ? <p role="status">此格式暂不支持应用内预览或编辑；文件身份和版本仍保留。可使用工具栏在外部应用打开当前原件。</p>
        : valid?.kind === "office" ? (officeHostError ? <p role="alert">{officeHostError}</p> : OfficeFileContent ? <OfficeFileContent visible={visible} fileName={valid.renderName} toolbar={editorToolbar} menuToolbar={editorMenu} binding={valid.binding} working={valid.working} baseline={{object:valid.object,versionNumber:valid.version,expectedContentHash:valid.contentHash}} readOnly={selection !== undefined} registerFlush={registerEditorFlush} onDirtyChange={dirty => editorDirtyChanged(valid, dirty)} onSaved={editorSaved} /> : <EditorLoading fileName={valid.renderName} stage="runtime" />)
        : valid?.kind === "markdown" ? <Suspense fallback={<EditorLoading format="markdown" stage="runtime" />}><MarkdownFileContent toolbar={editorToolbar} menuToolbar={editorMenu} binding={valid.binding} working={valid.working} baseline={{object:valid.object,versionNumber:valid.version,expectedContentHash:valid.contentHash}} text={valid.text!} resources={valid.resources} resolveResource={valid.resolveResource} line={line} sourceMode={source} initialView={initialView || views.current.has(valid.version) ? {...initialView,...views.current.get(valid.version)} : undefined} onViewChange={viewChanged} readOnly={selection !== undefined} registerFlush={registerEditorFlush} onDirtyChange={dirty=>editorDirtyChanged(valid, dirty)} onSaved={editorSaved}/></Suspense>
        : valid?.kind === "html" && !showSource ? <HtmlWebviewContent key={`${valid.version}:${valid.rendererId}`} binding={valid.binding} input={{object:valid.object,versionNumber:valid.version,expectedContentHash:valid.contentHash}} historical={selection !== undefined} visible={visible} />
        : valid ? <DshFilePreview key={`${valid.version}:${valid.rendererId}:${valid.kind}:${showSource}`} kind={showSource ? "text" : valid.kind} name={valid.renderName} text={valid.text} bytes={showSource ? undefined : valid.bytes} resources={valid.resources} signal={valid.signal} line={line} page={page} initialView={initialView || views.current.has(valid.version) ? { ...initialView, ...views.current.get(valid.version) } : undefined} onViewChange={viewChanged} /> : null}
    </div>
  </section>;
}
