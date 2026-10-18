import { EditorLoading } from "../document/EditorLoading";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Pencil, Save } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from '../../ui/components/Button';
import { EditorFileMenu } from '../document/EditorFileMenu';
import type { EditorOutputCommand } from '../../lib/editor-output';
import type { AgentWorkspaceBinding } from '../../lib/agent-types';
import type { FileBytesInput } from '../../lib/file-types';
import type { OfficeEdit, OfficeModel, DocxEdit, XlsxEdit, PptxEdit } from '../../lib/office-types';
import { OfficeEditSession } from '../../lib/office-edit-session';
import { officePreviewCache } from '../../lib/office-preview-cache';
import { officeFileApi } from '../../services/officeFileApi';
import { exportEditorFile } from '../../services/editorExport';
import { printEditorHtml, renderEditorPdf } from '../../services/editorPrint';
import { desktopApi } from '../../services/desktopApi';
import { inspectImportedWorkbook } from '../../services/editorWorkbookImport';
import './office-file-content.css';
import type { RecalculateRequest } from '../../../packages/office-xlsx/types';
const DocxEditor = lazy(() => import('./DocxEditor').then(module => ({default:module.DocxEditor})));
const XlsxEditor = lazy(() => import('./XlsxEditor').then(module => ({default:module.XlsxEditor})));
const PptxEditor = lazy(() => import('./PptxEditor').then(module => ({default:module.PptxEditor})));
async function convertAltChunkHtml(html: string) {
  const converter = await import('../../../packages/office-html2docx/dist/index.mjs');
  return converter.convertAltChunkHtml(html);
}
interface Props {
  toolbar: HTMLElement | null;
  menuToolbar?: HTMLElement | null;
  fileName?: string;
  binding: AgentWorkspaceBinding;
  baseline: FileBytesInput;
  readOnly: boolean;
  registerFlush: (flush: () => Promise<void>) => () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (version: number, hash: string) => void;
}
/** Format models are temporary editor state. File versions remain authoritative. */
export function OfficeFileContent({toolbar,menuToolbar,fileName,binding,baseline,readOnly,registerFlush,onDirtyChange,onSaved}:Props) {
  // Loading the exact renderer can overlap native parsing. Preview still uses
  // that renderer; failures are surfaced by its normal mount path.
  useEffect(() => {
    const extension = fileName?.split('.').pop()?.toLowerCase();
    const loading = extension === 'docx' ? import('../../../packages/office-docx/dist/editor.mjs')
      : extension === 'xlsx' ? import('../../../packages/office-xlsx/dist/browser.mjs')
      : extension === 'pptx' ? import('./PptxEditor') : undefined;
    void loading?.catch(() => {});
  },[fileName]);
  const objectKey = JSON.stringify(baseline.object);
  const session = useRef<OfficeEditSession<OfficeModel,OfficeEdit> | null>(null);
  const saveOperation = useRef<{session: OfficeEditSession<OfficeModel,OfficeEdit>; promise: Promise<void>} | null>(null);
  const sessionBinding = useRef<AgentWorkspaceBinding | null>(null);
  const [snapshot,setSnapshot] = useState<ReturnTypeSnapshot>();
  const [error,setError] = useState<string>();
  const [reading,setReading] = useState(true);
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
    const next = session.current.snapshot; setSnapshot(next); callbacks.current.onDirtyChange(next.edits.length > 0 || pendingEditor.current);
  };
  useEffect(() => {
    const current = session.current?.snapshot.baseline;
    if (sessionBinding.current?.workspaceId === binding.workspaceId && sessionBinding.current.generation === binding.generation
      && current?.versionNumber === baseline.versionNumber && current.expectedContentHash === baseline.expectedContentHash && JSON.stringify(current.object) === objectKey) return;
    const epoch = ++lifetime.current;
    session.current = null; pendingEditor.current = false; setEditorPending(false); setSnapshot(undefined); setReading(true); setError(undefined); setEditing(false); setOutputBusy(false); setOutputError(undefined);
    const cached = readOnly ? undefined : officePreviewCache.get(binding,baseline);
    void (cached ? Promise.resolve({model:cached}) : officeFileApi.inspect(binding,baseline)).then(result => {
      if (lifetime.current !== epoch) return;
      if (!cached) officePreviewCache.remember(binding,baseline,result.model);
      sessionBinding.current = binding;
      session.current = new OfficeEditSession(baseline,result.model,input => {
        const {requestId,...data} = input;
        return officeFileApi.save(binding,data,requestId);
      });
      publish();
    }).catch(reason => {if (lifetime.current === epoch) setError(message(reason));})
      .finally(() => {if (lifetime.current === epoch) setReading(false);});
  },[binding.workspaceId,binding.generation,objectKey,baseline.versionNumber,baseline.expectedContentHash]);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;lifetime.current++;callbacks.current.onDirtyChange(false);};
  },[]);
  function save(): Promise<void> {
    const current = session.current;
    if (!current || readOnly || (!editing && !current.snapshot.edits.length && !pendingEditor.current)) return Promise.resolve();
    if (saveOperation.current?.session === current) return saveOperation.current.promise;
    const promise = performSave(current).finally(() => {
      if (saveOperation.current?.promise === promise) saveOperation.current = null;
    });
    saveOperation.current = {session: current, promise};
    return promise;
  }
  async function performSave(current: OfficeEditSession<OfficeModel,OfficeEdit>) {
    const epoch = lifetime.current;
    setError(undefined);
    // Commit active format input into its journal before taking the File snapshot.
    if (beforeSave.current && !current.snapshot.saving) {
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
        officePreviewCache.remember(binding,current.snapshot.baseline,result.model);
        callbacks.current.onSaved(result.commit.receipt.versionNumber,result.commit.receipt.contentHash);
      }
    } catch (reason) {if (epoch === lifetime.current) {publish();setError(message(reason));} throw reason;}
  }
  const saveRef = useRef(save); saveRef.current = save;
  // Autosave only settled edits. Composition and uncommitted cell input keep the
  // timer cancelled; errors wait for an edit or an explicit retry.
  useEffect(() => {
    if (!editing || readOnly || !snapshot?.edits.length || editorPending || snapshot.saving || outputBusy || error) return;
    const timer = window.setTimeout(() => {if (!pendingEditor.current && !currentReadOnly.current) void saveRef.current().catch(() => {});},1200);
    return () => window.clearTimeout(timer);
  },[editing,readOnly,snapshot?.edits,editorPending,snapshot?.saving,outputBusy,error]);
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
    if (currentReadOnly.current || current.snapshot.saving) throw new Error('Word 文件只读或正在保存');
    if (current.snapshot.model.format !== 'docx') throw new Error('图片下载仅用于 Word 文档');
    const document = current.snapshot.baseline;
    const result = await desktopApi.fetchEditorRemoteImage({binding: currentBinding, document, url});
    if (epoch !== lifetime.current || currentReadOnly.current) throw new Error('Word 文件已关闭或切换');
    const latest = current.snapshot.baseline;
    if (latest.versionNumber !== document.versionNumber || latest.expectedContentHash !== document.expectedContentHash) {
      throw new Error('Word 文件版本已变更，请重新插入图片');
    }
    return result;
  }, []);
  const recalculate = useCallback(async (recalculation: RecalculateRequest) => {
    const current = session.current;
    const currentBinding = sessionBinding.current;
    if (!current || !currentBinding) throw new Error('Excel 文件尚未加载');
    const epoch = lifetime.current;
    const source = current.snapshot.baseline;
    const result = await officeFileApi.recalculate(currentBinding, {
      ...source, recalculation,
    });
    if (epoch !== lifetime.current) throw new Error('Excel 文件已关闭或切换');
    const latest = current.snapshot.baseline;
    if (latest.versionNumber !== source.versionNumber || latest.expectedContentHash !== source.expectedContentHash) {
      throw new Error('Excel 文件版本已变更，请重新计算');
    }
    return result;
  }, []);
  useEffect(() => registerFlush(() => saveRef.current()),[registerFlush]);
  function changed(edits:OfficeEdit[]) {
    if (!editing || readOnly) return;
    session.current?.replaceEdits(edits); setError(undefined); publish();
  }
  const editorPendingChanged = useCallback((pending:boolean) => {
    pending = pending && editing && !readOnly;
    pendingEditor.current = pending; setEditorPending(pending);
    callbacks.current.onDirtyChange(pending || !!session.current?.snapshot.edits.length);
  }, [editing,readOnly]);
  const frozen = !editing || readOnly || !!snapshot?.saving;
  async function finishEditing() {
    const epoch = lifetime.current;
    try {
      await save();
      if (mounted.current && epoch === lifetime.current && !session.current?.snapshot.edits.length && !pendingEditor.current) setEditing(false);
    } catch { /* The save error and draft remain in the editing surface. */ }
  }
  return <section className="office-file-content" aria-label="Office 文件内容" onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); void save().catch(() => {});
    }
  }}>
    {menuToolbar && snapshot ? createPortal(<EditorFileMenu format={snapshot.model.format} disabled={reading || outputBusy} documentKey={objectKey+baseline.versionNumber} onSelect={command => void runOutput(command)}/>,menuToolbar) : null}
    {toolbar ? createPortal(<>
      <span className="office-file-content__status" role="status">{readOnly ? '历史版本 · 只读' : error ? '保存失败' : snapshot?.saving ? '正在保存…' : snapshot?.edits.length || editorPending ? '未保存' : reading ? '正在读取…' : snapshot ? '已保存' : '无法读取'}</span>
      {!editing ? <Button type="button" variant="ghost" className="project-file-content__icon-button" size="sm" disabled={!snapshot} aria-label={readOnly ? '完整视图' : '编辑'} title={readOnly ? '完整视图' : '编辑'} leadingIcon={readOnly ? <Eye size={14} aria-hidden="true"/> : <Pencil size={14} aria-hidden="true"/>} onClick={() => setEditing(true)}/> : <>
        {!readOnly ? <Button type="button" variant="ghost" className="project-file-content__icon-button" size="sm" disabled={!snapshot || snapshot.saving || (!snapshot.edits.length && !editorPending && snapshot.model.format !== 'xlsx')} aria-label="保存" title="立即保存（默认自动保存）" leadingIcon={<Save size={14} aria-hidden="true" />} onClick={() => void save().catch(() => {})}/> : null}
        <Button type="button" variant="ghost" className="project-file-content__icon-button" size="sm" disabled={!!snapshot?.saving} aria-label={readOnly ? '快速预览' : '保存并预览'} title={readOnly ? '快速预览' : '保存并预览'} leadingIcon={<Eye size={14} aria-hidden="true"/>} onClick={() => void finishEditing()}/>
      </>}
    </>,toolbar) : null}
    {error ? <p role="alert">{error}{snapshot?.edits.length ? '。修改已保留，请解决后重试保存。' : ''}</p> : null}
    {outputError ? <p role="alert">{outputError}</p> : null}
    <div className="office-file-content__editor">
      {reading && !snapshot && !error ? <EditorLoading fileName={fileName} stage="parse" /> : null}
      <Suspense fallback={<EditorLoading format={snapshot?.model.format} stage="runtime" />}>
        {snapshot?.model.format === 'docx' ? <DocxEditor onFetchImage={fetchImage} onGetSystemFonts={desktopApi.listSystemFontFamilies} onFontMetrics={desktopApi.editorFontMetrics} onConvertAltChunkHtml={convertAltChunkHtml} model={snapshot.model} edits={snapshot.edits as DocxEdit[]} onChange={changed} readOnly={frozen} presentationMode={editing ? 'edit' : 'preview'} registerBeforeSave={registerBeforeSave} registerOutput={registerOutput} onPendingChange={editorPendingChanged} onSaveRequest={() => save()} onExport={exportEditorFile} onPrint={printEditorHtml} onRenderPdf={renderEditorPdf} />
          : snapshot?.model.format === 'xlsx' ? <XlsxEditor model={snapshot.model} edits={snapshot.edits as XlsxEdit[]} onChange={changed} readOnly={frozen} presentationMode={editing ? 'edit' : 'preview'} registerBeforeSave={registerBeforeSave} registerOutput={registerOutput} onPendingChange={editorPendingChanged} onSaveRequest={() => save()} onExport={exportEditorFile} onPrint={printEditorHtml} onRenderPdf={renderEditorPdf} onRecalculate={recalculate} onInspectImportedWorkbook={inspectImportedWorkbook} onCaptureScreenSources={desktopApi.editorCaptureSources} onCaptureScreenSource={desktopApi.editorCaptureSource} />
          : snapshot?.model.format === 'pptx' ? <PptxEditor model={snapshot.model} edits={snapshot.edits as PptxEdit[]} onChange={changed} readOnly={frozen} presentationMode={editing ? 'edit' : 'preview'} registerBeforeSave={registerBeforeSave} registerOutput={registerOutput} onPendingChange={editorPendingChanged} onSaveRequest={() => save()} onExport={exportEditorFile} onPrint={printEditorHtml} onRenderPdf={renderEditorPdf} /> : null}
      </Suspense>
    </div>
  </section>;
}
type ReturnTypeSnapshot = OfficeEditSession<OfficeModel,OfficeEdit>['snapshot'];
function message(error:unknown) {return error instanceof Error ? error.message : String(error);}
