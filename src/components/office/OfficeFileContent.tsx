import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from '../../ui/components/Button';
import type { AgentWorkspaceBinding } from '../../lib/agent-types';
import type { FileBytesInput } from '../../lib/file-types';
import type { OfficeEdit, OfficeModel, DocxEdit, XlsxEdit, PptxEdit } from '../../lib/office-types';
import { OfficeEditSession } from '../../lib/office-edit-session';
import { officeFileApi } from '../../services/officeFileApi';
import './office-file-content.css';
const DocxEditor = lazy(() => import('./DocxEditor').then(module => ({default:module.DocxEditor})));
const XlsxEditor = lazy(() => import('./XlsxEditor').then(module => ({default:module.XlsxEditor})));
const PptxEditor = lazy(() => import('./PptxEditor').then(module => ({default:module.PptxEditor})));
interface Props {
  toolbar: HTMLElement | null;
  binding: AgentWorkspaceBinding;
  baseline: FileBytesInput;
  readOnly: boolean;
  registerFlush: (flush: () => Promise<void>) => () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (version: number, hash: string) => void;
}
/** Format models are temporary editor state. File versions remain authoritative. */
export function OfficeFileContent({toolbar,binding,baseline,readOnly,registerFlush,onDirtyChange,onSaved}:Props) {
  const session = useRef<OfficeEditSession<OfficeModel,OfficeEdit> | null>(null);
  const sessionBinding = useRef<AgentWorkspaceBinding | null>(null);
  const [snapshot,setSnapshot] = useState<ReturnTypeSnapshot>();
  const [error,setError] = useState<string>();
  const [reading,setReading] = useState(true);
  const lifetime = useRef(0);
  const beforeSave = useRef<(() => Promise<void>) | null>(null);
  const pendingCell = useRef(false);
  const [cellPending,setCellPending] = useState(false);
  const registerBeforeSave = useCallback((commit: () => Promise<void>) => {
    beforeSave.current = commit;
    return () => { if (beforeSave.current === commit) beforeSave.current = null; };
  }, []);
  const callbacks = useRef({onSaved,onDirtyChange}); callbacks.current = {onSaved,onDirtyChange};
  const publish = () => {
    if (!session.current) return;
    const next = session.current.snapshot; setSnapshot(next); callbacks.current.onDirtyChange(next.edits.length > 0 || pendingCell.current);
  };
  useEffect(() => {
    const current = session.current?.snapshot.baseline;
    if (sessionBinding.current?.workspaceId === binding.workspaceId && sessionBinding.current.generation === binding.generation
      && current?.versionNumber === baseline.versionNumber && current.expectedContentHash === baseline.expectedContentHash) return;
    const epoch = ++lifetime.current;
    session.current = null; pendingCell.current = false; setCellPending(false); setSnapshot(undefined); setReading(true); setError(undefined);
    void officeFileApi.inspect(binding,baseline).then(result => {
      if (lifetime.current !== epoch) return;
      sessionBinding.current = binding;
      session.current = new OfficeEditSession(baseline,result.model,input => {
        const {requestId,...data} = input;
        return officeFileApi.save(binding,data,requestId);
      });
      publish();
    }).catch(reason => {if (lifetime.current === epoch) setError(message(reason));})
      .finally(() => {if (lifetime.current === epoch) setReading(false);});
  },[binding.workspaceId,binding.generation,baseline.versionNumber,baseline.expectedContentHash]);
  useEffect(() => () => {lifetime.current++;callbacks.current.onDirtyChange(false);},[]);
  async function save() {
    const current = session.current;
    if (!current || readOnly) return;
    const epoch = lifetime.current;
    setError(undefined);
    // A spreadsheet cell can still be in its input editor. Commit that input
    // into the edit journal before taking the File save snapshot.
    if (beforeSave.current && !current.snapshot.saving) {
      try { await beforeSave.current(); }
      catch (reason) { if (epoch === lifetime.current) setError(message(reason)); throw reason; }
      if (epoch !== lifetime.current) return;
    }
    const pending = current.save(); publish();
    try {
      const result = await pending;
      if (epoch !== lifetime.current) return;
      publish();
      if (result) callbacks.current.onSaved(result.commit.receipt.versionNumber,result.commit.receipt.contentHash);
    } catch (reason) {if (epoch === lifetime.current) {publish();setError(message(reason));} throw reason;}
  }
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => registerFlush(() => saveRef.current()),[registerFlush]);
  function changed(edits:OfficeEdit[]) {
    session.current?.replaceEdits(edits); setError(undefined); publish();
  }
  const cellPendingChanged = useCallback((pending:boolean) => {
    pendingCell.current = pending; setCellPending(pending);
    callbacks.current.onDirtyChange(pending || !!session.current?.snapshot.edits.length);
  }, []);
  const frozen = readOnly || !!snapshot?.saving;
  return <section className="office-file-content" aria-label="Office 文件内容" onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); void save().catch(() => {});
    }
  }}>
    {toolbar ? createPortal(<>
      <span className="office-file-content__status" role="status">{readOnly ? '历史版本 · 只读' : snapshot?.saving ? '正在保存…' : snapshot?.edits.length || cellPending ? '未保存' : reading ? '正在读取…' : snapshot ? '已保存' : '无法读取'}</span>
      {!readOnly ? <Button type="button" size="sm" disabled={!snapshot || snapshot.saving || (!snapshot.edits.length && snapshot.model.format !== 'xlsx')} leadingIcon={<Save size={14} aria-hidden="true" />} onClick={() => void save().catch(() => {})}>保存</Button> : null}
    </>,toolbar) : null}
    {error ? <p role="alert">{error}{snapshot?.edits.length ? '。修改已保留，请解决后重试保存。' : ''}</p> : null}
    <div className="office-file-content__editor">
      <Suspense fallback={<p role="status">正在加载编辑器…</p>}>
        {snapshot?.model.format === 'docx' ? <DocxEditor model={snapshot.model} edits={snapshot.edits as DocxEdit[]} onChange={changed} readOnly={frozen} />
          : snapshot?.model.format === 'xlsx' ? <XlsxEditor model={snapshot.model} edits={snapshot.edits as XlsxEdit[]} onChange={changed} readOnly={frozen} registerBeforeSave={registerBeforeSave} onPendingChange={cellPendingChanged} />
          : snapshot?.model.format === 'pptx' ? <PptxEditor model={snapshot.model} edits={snapshot.edits as PptxEdit[]} onChange={changed} readOnly={frozen} /> : null}
      </Suspense>
    </div>
  </section>;
}
type ReturnTypeSnapshot = OfficeEditSession<OfficeModel,OfficeEdit>['snapshot'];
function message(error:unknown) {return error instanceof Error ? error.message : String(error);}
