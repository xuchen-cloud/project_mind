import type {OfficePreviewAccess,OfficePreviewView} from '../../../packages/editor-chrome/preview-view';
import { EditorLoading } from "../document/EditorLoading";
import { Component, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Eye, Pencil, Quote, Save } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from '../../ui/components/Button';
import { EditorFileMenu } from '../document/EditorFileMenu';
import type { EditorOutputCommand } from '../../lib/editor-output';
import type { AgentWorkspaceBinding } from '../../lib/agent-types';
import type { FileBytesInput } from '../../lib/file-types';
import type { OfficeEdit, OfficeModel, DocxEdit, XlsxEdit, PptxEdit } from '../../lib/office-types';
import {useOfficeSelection} from '../../hooks/useOfficeSelection';
import {FileEditSession} from '../../lib/file-edit-session';
import {fileWorkingApi, type FileWorkingOpen, type FileWorkingStatus} from '../../services/fileWorkingApi';
import { officeFileApi } from '../../services/officeFileApi';
import { exportEditorFile } from '../../services/editorExport';
import { printEditorHtml, renderEditorPdf } from '../../services/editorPrint';
import { desktopApi } from '../../services/desktopApi';
import { inspectImportedWorkbook } from '../../services/editorWorkbookImport';
import './office-file-content.css';
import type { RecalculateRequest, RecalculateResult, OfficeViewRead } from '../../../packages/office-xlsx/types';
import {loadDocxEditor, loadXlsxEditor, loadPptxEditor} from './office-component-loader';
async function convertAltChunkHtml(html: string) {
  const converter = await import('../../../packages/office-html2docx/dist/index.mjs');
  return converter.convertAltChunkHtml(html);
}
interface Props {
  visible?: boolean;
  toolbar: HTMLElement | null;
  menuToolbar?: HTMLElement | null;
  fileName?: string;
  binding: AgentWorkspaceBinding;
  baseline: FileBytesInput;
  working?: FileWorkingOpen;
  readOnly: boolean;
  registerFlush: (flush: () => Promise<void>) => () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (version: number, hash: string, working?: FileWorkingStatus) => void;
}
/** Format models are temporary editor state. File versions remain authoritative. */
export function OfficeFileContent({visible=true,toolbar,menuToolbar,fileName,binding,baseline,working,readOnly,registerFlush,onDirtyChange,onSaved}:Props) {
  const [components, setComponents] = useState<{
    docx?: typeof import('./DocxEditor').DocxEditor;
    xlsx?: typeof import('./XlsxEditor').XlsxEditor;
    pptx?: typeof import('./PptxEditor').PptxEditor;
  }>({});
  const [componentError, setComponentError] = useState<string>();
  const DocxEditor = components.docx, XlsxEditor = components.xlsx, PptxEditor = components.pptx;
  useEffect(() => {if (import.meta.env.OFFICE_PERFORMANCE) performance.mark('office-component:host:mounted');}, []);
  // Loading the exact renderer can overlap native parsing. Preview still uses
  // that renderer; failures are surfaced by its normal mount path.
  useEffect(() => {
    const extension = fileName?.split('.').pop()?.toLowerCase();
    let active = true;
    let cancelHints: (() => void) | undefined;
    const loading = extension === 'docx' ? Promise.all([
      import('../../../packages/office-docx/dist/full-editor.mjs'),
      import('../../../packages/office-docx/dist/renderer.html?office-resource'),
    ]) : extension === 'xlsx' ? Promise.all([
      import('../../../packages/office-xlsx/dist/browser.mjs'),
      import('../../../packages/office-xlsx/dist/renderer.html?office-resource'),
    ]) : extension === 'pptx' ? Promise.all([
      import('./PptxEditor'),
      import('../../../packages/office-pptx/dist/renderer.html?office-resource'),
    ]) : undefined;
    // Only the selected format's module/style hints overlap inspect. They fetch
    // and compile resources without executing a renderer or retaining a model.
    void loading?.then(([,resource]) => { if (active) cancelHints = resource.preload(); }).catch(() => {});
    return () => { active = false; cancelHints?.(); };
  },[fileName]);
  const objectKey = JSON.stringify(baseline.object);
  const viewIdentity = JSON.stringify([binding.workspaceId,binding.generation,working?.sessionId ?? baseline]);
  const sessionIdentity = useRef<string | undefined>(undefined);
  const liveSource = useRef({working,baseline}); liveSource.current = {working,baseline};
  const session = useRef<FileEditSession<OfficeModel,OfficeEdit> | null>(null);
  const recalculations = useRef(new Map<string, Promise<RecalculateResult>>());
  const saveOperation = useRef<{session: FileEditSession<OfficeModel,OfficeEdit>; promise: Promise<void>} | null>(null);
  const sessionBinding = useRef<AgentWorkspaceBinding | null>(null);
  const [suspended,setSuspended] = useState(!visible);
  const previewView = useRef<OfficePreviewView | undefined>(undefined);
  const captureFailure = useRef<unknown>(undefined);
  const previousViewIdentity = useRef(viewIdentity);
  if (previousViewIdentity.current !== viewIdentity) {previousViewIdentity.current = viewIdentity;previewView.current = undefined;}
  const [previewAccess,setPreviewAccess] = useState<OfficePreviewAccess>();
  const registerPreview = useCallback((access:OfficePreviewAccess) => {
    setPreviewAccess(access);
    return () => setPreviewAccess(current => current === access ? undefined : current);
  },[]);
  const [snapshot,setSnapshot] = useState<ReturnTypeSnapshot>();
  const [error,setError] = useState<string>();
  const [reading,setReading] = useState(true);
  const selectedFormat = snapshot?.model.format ?? fileName?.match(/\.(docx|xlsx|pptx)$/iu)?.[1].toLowerCase();
  useEffect(() => {
    let active = true;
    setComponentError(undefined);
    const loaded = selectedFormat === 'docx' ? loadDocxEditor().then(module => ({docx:module.DocxEditor}))
      : selectedFormat === 'xlsx' ? loadXlsxEditor().then(module => ({xlsx:module.XlsxEditor}))
      : selectedFormat === 'pptx' ? loadPptxEditor().then(module => ({pptx:module.PptxEditor})) : undefined;
    void loaded?.then(component => {if (active) setComponents(previous => ({...previous,...component}));},
      failure => {if (active) setComponentError(message(failure));});
    return () => {active = false;};
  }, [selectedFormat]);
  const [editing,setEditing] = useState(false);
  const [outputBusy,setOutputBusy] = useState(false);
  const [outputError,setOutputError] = useState<string>();
  const output = useRef<((command:EditorOutputCommand)=>Promise<void>) | null>(null);
  const registerOutput = useCallback((handler:(command:EditorOutputCommand)=>Promise<void>) => {
    output.current = handler;
    return () => {if (output.current === handler) output.current = null;};
  },[]);
  const lifetime = useRef(0);
  const mounted = useRef(true);
  const currentReadOnly = useRef(readOnly); currentReadOnly.current = readOnly;
  const beforeSave = useRef<(() => Promise<void>) | null>(null);
  const pendingEditor = useRef(false);
  const [editorPending,setEditorPending] = useState(false);
  const registerBeforeSave = useCallback((commit: () => Promise<void>) => {
    beforeSave.current = commit;
    return () => { if (beforeSave.current === commit) beforeSave.current = null; };
  }, []);
  const callbacks = useRef({onSaved,onDirtyChange}); callbacks.current = {onSaved,onDirtyChange};
  const publish = () => {
    if (!session.current) return;
    const next = session.current.snapshot; setSnapshot(next); callbacks.current.onDirtyChange(next.dirty || pendingEditor.current);
  };
  useEffect(() => {
    if (working) {session.current?.acknowledgeStatus(working);publish();}
  },[working?.revision,working?.archivedVersionNumber,working?.pendingArchive]);
  useEffect(() => {
    if (suspended) {
      lifetime.current++;session.current = null;sessionBinding.current = null;sessionIdentity.current = undefined;
      recalculations.current.clear();setSnapshot(undefined);setReading(false);
      return;
    }
    if (sessionIdentity.current === viewIdentity) return;
    sessionIdentity.current = viewIdentity;
    const epoch = ++lifetime.current;
    recalculations.current.clear();
    session.current = null;pendingEditor.current = false;setEditorPending(false);setSnapshot(undefined);setReading(true);setError(undefined);setEditing(false);setOutputBusy(false);setOutputError(undefined);
    const opened = readOnly ? officeFileApi.inspectView(binding,baseline) : working?.model
      ? Promise.resolve({model:working.model}) : Promise.reject(new Error('当前文件尚未建立编辑会话'));
    void opened.then(result => {
      if (lifetime.current !== epoch) return;
      sessionBinding.current = binding;
      session.current = new FileEditSession(working,result.model,input => {
        const {requestId,...data} = input;
        return fileWorkingApi.saveOffice(binding,data,requestId);
      });
      publish();
    }).catch(reason => {if (lifetime.current === epoch) setError(message(reason));})
      .finally(() => {if (lifetime.current === epoch) setReading(false);});
  },[viewIdentity,suspended]);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;lifetime.current++;recalculations.current.clear();callbacks.current.onDirtyChange(false);};
  },[]);
  function save(commitInput = true): Promise<void> {
    const current = session.current;
    if (!current || readOnly || (!editing && !current.snapshot.dirty && !pendingEditor.current)) return Promise.resolve();
    if (saveOperation.current?.session === current) return saveOperation.current.promise;
    const promise = performSave(current,commitInput).finally(() => {
      if (saveOperation.current?.promise === promise) saveOperation.current = null;
    });
    saveOperation.current = {session: current, promise};
    return promise;
  }
  async function performSave(current: FileEditSession<OfficeModel,OfficeEdit>, commitInput: boolean) {
    const epoch = lifetime.current;
    setError(undefined);
    // Commit active format input into its journal before taking the File snapshot.
    if (commitInput && beforeSave.current && !current.snapshot.saving) {
      try { await beforeSave.current(); }
      catch (reason) { if (epoch === lifetime.current) setError(message(reason)); throw reason; }
      if (epoch !== lifetime.current) return;
    }
    if (currentReadOnly.current) {
      const reason = new Error('文件已切换为只读，无法保存');
      setError(reason.message);
      throw reason;
    }
    const pending = current.save(); publish();
    try {
      const result = await pending;
      if (epoch !== lifetime.current) return;
      publish();
      if (result) {
        callbacks.current.onSaved(result.receipt.archivedVersionNumber,result.receipt.contentHash,result.receipt);
      }
    } catch (reason) {if (epoch === lifetime.current) {publish();setError(message(reason));} throw reason;}
  }
  const saveRef = useRef(save); saveRef.current = save;
  // Autosave only settled edits. Composition and uncommitted cell input keep the
  // timer cancelled; errors wait for an edit or an explicit retry.
  useEffect(() => {
    if (!editing || readOnly || !snapshot?.dirty || editorPending || snapshot.saving || outputBusy || error) return;
    const timer = window.setTimeout(() => {if (!pendingEditor.current && !currentReadOnly.current) void saveRef.current(false).catch(() => {});},1200);
    return () => window.clearTimeout(timer);
  },[editing,readOnly,snapshot?.editRevision,editorPending,snapshot?.saving,outputBusy,error]);
  async function runOutput(command:EditorOutputCommand) {
    const epoch = lifetime.current;
    const handler = output.current;
    if (outputBusy) return;
    setOutputBusy(true); setOutputError(undefined);
    try {if (!handler) throw Error('编辑器尚未加载');await handler(command);}
    catch (reason) {if (epoch === lifetime.current) setOutputError(message(reason));}
    finally {if (epoch === lifetime.current) setOutputBusy(false);}
  }
  const fetchImage = useCallback(async (url: string) => {
    if (!mounted.current) throw new Error('Word 文件已关闭或切换');
    const current = session.current;
    const currentBinding = sessionBinding.current;
    const epoch = lifetime.current;
    if (!current || !currentBinding) throw new Error('Word 文件尚未加载');
    if (currentReadOnly.current) throw new Error('Word 文件只读');
    if (current.snapshot.model.format !== 'docx') throw new Error('图片下载仅用于 Word 文档');
    const document = liveSource.current.baseline;
    const result = await desktopApi.fetchEditorRemoteImage({binding: currentBinding, document, workingSessionId:liveSource.current.working?.sessionId, url});
    if (epoch !== lifetime.current || currentReadOnly.current) throw new Error('Word 文件已关闭或切换');
    return result;
  }, []);
  const recalculate = useCallback(async (recalculation: RecalculateRequest) => {
    const current = session.current;
    const currentBinding = sessionBinding.current;
    if (!current || !currentBinding) throw new Error('Excel 文件尚未加载');
    const epoch = lifetime.current;
    const source = liveSource.current.working;
    if (!source) throw new Error('当前文件尚未建立编辑会话');
    // Only identical pending work shares a native invocation. Different edit
    // journals keep their own result/error; settled results are never cached.
    const key = JSON.stringify([epoch, source, recalculation]);
    const existing = recalculations.current.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const result = await fileWorkingApi.recalculate(currentBinding, {object:source.object,sessionId:source.sessionId,recalculation});
      if (epoch !== lifetime.current) throw new Error('Excel 文件已关闭或切换');
      if (session.current !== current) {
        throw new Error('Excel 文件版本已变更，请重新计算');
      }
      return result;
    })();
    recalculations.current.set(key, operation);
    try { return await operation; }
    finally { if (recalculations.current.get(key) === operation) recalculations.current.delete(key); }
  }, []);
  const readView = useCallback(async (read: OfficeViewRead) => {
    const current = session.current, currentBinding = sessionBinding.current;
    if (!current || !currentBinding) throw new Error('Excel 文件尚未加载');
    const epoch = lifetime.current, source = liveSource.current.working;
    const result = source
      ? await fileWorkingApi.readView(currentBinding,{object:source.object,sessionId:source.sessionId,read})
      : await officeFileApi.readView(currentBinding,{...liveSource.current.baseline,read});
    if (epoch !== lifetime.current || current !== session.current) throw new Error('Excel 文件已关闭或切换');
    return result;
  }, []);
  useEffect(() => registerFlush(async () => {
    const current = session.current;
    await saveRef.current();
    while (session.current === current && (current?.snapshot.dirty || pendingEditor.current)) {
      if (currentReadOnly.current) throw new Error('文件已切换为只读，无法完成保存');
      await saveRef.current();
    }
  }),[registerFlush]);
  function changed(edits:OfficeEdit[], revision?: {editRevision:number}) {
    if (!editing || readOnly) return;
    session.current?.replaceEdits(edits,revision); setError(undefined); publish(); reportActivity();
  }
  function reportActivity() {
    if (!working || currentReadOnly.current) return;
    const epoch = lifetime.current;
    void fileWorkingApi.activity(binding,{object:working.object,sessionId:working.sessionId}).then(status => {
      if (epoch === lifetime.current) session.current?.acknowledgeStatus(status);
    }).catch(reason => {if (epoch === lifetime.current) setError(message(reason));});
  }
  useEffect(() => {
    if (!editorPending || readOnly) return;
    reportActivity();
    const timer = window.setInterval(reportActivity,30_000);
    return () => window.clearInterval(timer);
  },[editorPending,readOnly,working?.sessionId]);
  const editorPendingChanged = useCallback((pending:boolean) => {
    pending = pending && editing && !readOnly;
    pendingEditor.current = pending; setEditorPending(pending);
    callbacks.current.onDirtyChange(pending || !!session.current?.snapshot.dirty);
  }, [editing,readOnly]);
  useLayoutEffect(() => {
    if (visible) {captureFailure.current=undefined;setSuspended(false);return;}
    // Keep the editor mounted when hidden so tab switching is instant.
    // The parent's [hidden] wrapper handles visual hiding; the iframe stays
    // alive and the renderer does not reload on re-visibility. The session is
    // only cleared when the document binding actually changes (see effect above).
  },[visible]);
  const frozen = !editing || readOnly;
  const selection = useOfficeSelection({
    binding, object: baseline.object, format: snapshot?.model.format, label: fileName ?? 'Office 文件',
    enabled: visible && editing && !readOnly && !reading, writable: !frozen && !outputBusy,
    model: snapshot?.model,
    async prepareCapture() {
      await saveRef.current();
      return true;
    },
  });
  async function finishEditing() {
    const epoch = lifetime.current;
    try {
      await save();
      if (mounted.current && epoch === lifetime.current && !session.current?.snapshot.dirty && !pendingEditor.current) setEditing(false);
    } catch { /* The save error and draft remain in the editing surface. */ }
  }
  return <OfficeVisibilitySnapshot visible={visible} beforeHide={() => {
    if (!editing && !snapshot?.dirty && !editorPending && !snapshot?.saving && previewAccess) {
      previewView.current = undefined;
      try {previewView.current = previewAccess.capture();} catch (reason) {captureFailure.current=reason;}
    }
  }}><section className="office-file-content" aria-label="Office 文件内容" onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); void save().catch(() => {});
    }
  }}>
    {menuToolbar && snapshot ? createPortal(<EditorFileMenu format={snapshot.model.format} disabled={reading || outputBusy} documentKey={objectKey+baseline.versionNumber} onSelect={command => void runOutput(command)}/>,menuToolbar) : null}
    {toolbar ? createPortal(<>
      <span className="office-file-content__status" role="status">{readOnly ? '历史版本 · 只读' : error ? '保存失败' : snapshot?.saving ? '正在保存…' : snapshot?.dirty || editorPending ? '未保存' : reading ? '正在读取…' : snapshot ? (snapshot.working?.pendingArchive ? '已保存 · 空闲后保留版本' : '已保存') : '无法读取'}</span>
      {!editing ? <Button type="button" variant="ghost" className="project-file-content__icon-button" size="sm" disabled={!snapshot} aria-label={readOnly ? '完整视图' : '编辑'} title={readOnly ? '完整视图' : '编辑'} leadingIcon={readOnly ? <Eye size={14} aria-hidden="true"/> : <Pencil size={14} aria-hidden="true"/>} onClick={() => setEditing(true)}/> : <>
        {!readOnly ? <Button type="button" variant="ghost" className="project-file-content__icon-button" size="sm" disabled={!snapshot || snapshot.saving || (!snapshot.dirty && !editorPending && snapshot.model.format !== 'xlsx')} aria-label="保存" title="立即保存（默认自动保存）" leadingIcon={<Save size={14} aria-hidden="true" />} onClick={() => void save().catch(() => {})}/> : null}
        {!readOnly ? <Button type="button" variant="ghost" className="project-file-content__icon-button" size="sm" disabled={!selection.available || selection.busy || outputBusy} aria-label="引用选区" title="引用当前选区到项目会话" onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} leadingIcon={<Quote size={14} aria-hidden="true"/>} onClick={() => void selection.quoteSelection()}/> : null}
        <Button type="button" variant="ghost" className="project-file-content__icon-button" size="sm" disabled={!!snapshot?.saving} aria-label={readOnly ? '快速预览' : '保存并预览'} title={readOnly ? '快速预览' : '保存并预览'} leadingIcon={<Eye size={14} aria-hidden="true"/>} onClick={() => void finishEditing()}/>
      </>}
    </>,toolbar) : null}
    {error ? <p role="alert">{error}{snapshot?.dirty ? '。修改已保留，请解决后重试保存。' : ''}</p> : null}
    {selection.error ? <p role="alert">{selection.error}</p> : null}
    {outputError ? <p role="alert">{outputError}</p> : null}
    <div className="office-file-content__editor">
      {reading && !snapshot && !error ? <EditorLoading fileName={fileName} stage="parse" /> : null}
      {componentError ? <p role="alert">{componentError}</p> : null}
      {snapshot && !components[snapshot.model.format] && !componentError ? <EditorLoading format={snapshot.model.format} stage="runtime" /> : null}
      <OfficeFormatCommit format={snapshot && components[snapshot.model.format] ? snapshot.model.format : undefined}>
        {!suspended && snapshot?.model.format === 'docx' && DocxEditor ? <DocxEditor registerPreview={registerPreview} initialPreviewView={previewView.current} onFetchImage={fetchImage} onGetSystemFonts={desktopApi.listSystemFontFamilies} onFontMetrics={desktopApi.editorFontMetrics} onConvertAltChunkHtml={convertAltChunkHtml} savedEditRevision={snapshot.savedEditRevision} model={snapshot.model} edits={snapshot.edits as DocxEdit[]} onChange={changed} readOnly={frozen} presentationMode={editing ? 'edit' : 'preview'} registerSelection={selection.registerSelection} registerBeforeSave={registerBeforeSave} registerOutput={registerOutput} onPendingChange={editorPendingChanged} onSaveRequest={() => save()} onExport={exportEditorFile} onPrint={printEditorHtml} onRenderPdf={renderEditorPdf} />
          : !suspended && snapshot?.model.format === 'xlsx' && XlsxEditor ? <XlsxEditor registerPreview={registerPreview} initialPreviewView={previewView.current} savedEditRevision={snapshot.savedEditRevision} model={snapshot.model} edits={snapshot.edits as XlsxEdit[]} onChange={changed} readOnly={frozen} presentationMode={editing ? 'edit' : 'preview'} registerSelection={selection.registerSelection} registerBeforeSave={registerBeforeSave} registerOutput={registerOutput} onPendingChange={editorPendingChanged} onSaveRequest={() => save()} onExport={exportEditorFile} onPrint={printEditorHtml} onRenderPdf={renderEditorPdf} onRecalculate={recalculate} onReadView={readView} onInspectImportedWorkbook={inspectImportedWorkbook} onCaptureScreenSources={desktopApi.editorCaptureSources} onCaptureScreenSource={desktopApi.editorCaptureSource} />
          : !suspended && snapshot?.model.format === 'pptx' && PptxEditor ? <PptxEditor registerPreview={registerPreview} initialPreviewView={previewView.current} savedEditRevision={snapshot.savedEditRevision} model={snapshot.model} edits={snapshot.edits as PptxEdit[]} onChange={changed} readOnly={frozen} presentationMode={editing ? 'edit' : 'preview'} registerSelection={selection.registerSelection} registerBeforeSave={registerBeforeSave} registerOutput={registerOutput} onPendingChange={editorPendingChanged} onSaveRequest={() => save()} onExport={exportEditorFile} onPrint={printEditorHtml} onRenderPdf={renderEditorPdf} /> : null}
      </OfficeFormatCommit>
    </div>
  </section></OfficeVisibilitySnapshot>;
}
type ReturnTypeSnapshot = FileEditSession<OfficeModel,OfficeEdit>['snapshot'];
function message(error:unknown) {return error instanceof Error ? error.message : String(error);}

function OfficeFormatCommit({format, children}: {format?: string; children: import('react').ReactNode}) {
  useEffect(() => {if (format && import.meta.env.OFFICE_PERFORMANCE) performance.mark(`office-component:${format}:mounted`);}, [format]);
  return <>{children}</>;
}

/** React's pre-mutation snapshot runs before any ancestor sets hidden/display.
 * A layout effect alone would observe a renderer whose scroll boxes are gone. */
class OfficeVisibilitySnapshot extends Component<{visible:boolean;beforeHide:()=>void;children:ReactNode}> {
  getSnapshotBeforeUpdate(previous:Readonly<{visible:boolean}>) {if(previous.visible&&!this.props.visible)this.props.beforeHide();return null;}
  componentDidUpdate() {}
  render(){return this.props.children;}
}
