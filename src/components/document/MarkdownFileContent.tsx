import { EditorLoading } from "./EditorLoading";
import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Save} from 'lucide-react';
import type {AgentWorkspaceBinding} from '../../lib/agent-types';
import type {FileBytesInput} from '../../lib/file-types';
import {FileEditSession} from '../../lib/file-edit-session';
import {fileWorkingApi, type FileWorkingOpen, type FileWorkingStatus} from '../../services/fileWorkingApi';
import {exportEditorFile} from '../../services/editorExport';
import {printEditorHtml, renderEditorPdf} from '../../services/editorPrint';
import {Button} from '../../ui/components/Button';
import '../office/office-file-content.css';
import '../markdown/markdown-editor.css';

const MarkdownEditor = lazy(() => import('../markdown/MarkdownEditor').then(module => ({default: module.MarkdownEditor})));

interface Props {
  toolbar: HTMLElement | null;
  menuToolbar?: HTMLElement | null;
  binding: AgentWorkspaceBinding;
  baseline: FileBytesInput;
  working?: FileWorkingOpen;
  text: string;
  readOnly: boolean;
  resources?: Record<string, string>;
  resolveResource?: (reference: string) => Promise<string | undefined>;
  line?: number;
  sourceMode?: boolean;
  initialView?: {scrollTop?: number; zoom?: number};
  onViewChange?: (view: {scrollTop?: number; zoom?: number; sourceMode?: boolean}) => void;
  registerFlush: (flush: () => Promise<void>) => () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (version: number, hash: string, working?: FileWorkingStatus, text?: string) => void;
}

export function MarkdownFileContent({toolbar, menuToolbar, binding, baseline, working, text, readOnly, resources, resolveResource, line, sourceMode, initialView, onViewChange, registerFlush, onDirtyChange, onSaved}: Props) {
  const session = useRef<FileEditSession<string, string> | null>(null);
  const saveOperation = useRef<{session: FileEditSession<string, string>; promise: Promise<void>} | null>(null);
  const identity = useRef('');
  const editorEpoch = useRef(0);
  const key = JSON.stringify([binding.workspaceId,binding.generation,baseline.object,working?.sessionId ?? baseline.versionNumber,working ? undefined : baseline.expectedContentHash]);
  const [snapshot, setSnapshot] = useState<FileEditSession<string, string>['snapshot']>();
  const [error, setError] = useState<string>();
  const beforeSave = useRef<(() => Promise<void>) | null>(null);
  const currentReadOnly = useRef(readOnly); currentReadOnly.current = readOnly;
  const pending = useRef(false);
  const [isPending, setPending] = useState(false);
  const callbacks = useRef({onDirtyChange, onSaved});
  callbacks.current = {onDirtyChange, onSaved};

  function reportActivity() {
    if (!working || currentReadOnly.current) return;
    const epoch = identity.current;
    void fileWorkingApi.activity(binding, {object:working.object,sessionId:working.sessionId}).then(status=>{if(identity.current===epoch)session.current?.acknowledgeStatus(status);}).catch(reason => {
      if (identity.current === epoch) setError(reason instanceof Error ? reason.message : String(reason));
    });
  }

  function publish() {
    const next = session.current?.snapshot;
    setSnapshot(next);
    callbacks.current.onDirtyChange(!!next?.dirty || pending.current);
  }

  useEffect(() => {
    if (identity.current === key) return;
    identity.current = key;
    editorEpoch.current++;
    pending.current = false;
    setPending(false);
    setError(undefined);
    session.current = new FileEditSession(working, text, async input => {
      const {edits, requestId, ...fixed} = input;
      const source = edits[0] ?? text;
      return fileWorkingApi.saveText(binding, {...fixed, text: source}, requestId);
    });
    publish();
  }, [key, text]);

  useEffect(() => () => {
    identity.current = '';
    callbacks.current.onDirtyChange(false);
  }, []);

  const registerBeforeSave = useCallback((commit: () => Promise<void>) => {
    beforeSave.current = commit;
    return () => {
      if (beforeSave.current === commit) beforeSave.current = null;
    };
  }, []);

  const pendingChanged = useCallback((value: boolean) => {
    value = value && !readOnly;
    if (value) reportActivity();
    pending.current = value;
    setPending(value);
    callbacks.current.onDirtyChange(value || !!session.current?.snapshot.dirty);
  }, [readOnly,working?.sessionId,binding]);

  function save(): Promise<void> {
    const current = session.current;
    if (!current || readOnly) return Promise.resolve();
    if (saveOperation.current?.session === current) return saveOperation.current.promise;
    const promise = performSave(current).finally(() => {
      if (saveOperation.current?.promise === promise) saveOperation.current = null;
    });
    saveOperation.current = {session: current, promise};
    return promise;
  }
  async function performSave(current: FileEditSession<string, string>) {
    const epoch = identity.current;
    setError(undefined);
    try {
      if (beforeSave.current && !current.snapshot.saving) await beforeSave.current();
      if (identity.current !== epoch) return;
      if (currentReadOnly.current) throw new Error('文件已切换为只读，无法保存');
      const saving = current.save();
      publish();
      const result = await saving;
      if (identity.current !== epoch) return;
      publish();
      if (result) callbacks.current.onSaved(result.receipt.archivedVersionNumber, result.receipt.contentHash, result.receipt, result.edits[0] ?? current.snapshot.model);
    } catch (reason) {
      if (identity.current === epoch) {
        publish();
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      throw reason;
    }
  }

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => registerFlush(async () => {
    do {
      await saveRef.current();
      if(currentReadOnly.current)return;
    } while(session.current?.snapshot.dirty || pending.current);
  }), [registerFlush]);
  useEffect(() => {
    if (readOnly || !snapshot?.dirty || isPending || snapshot.saving || error) return;
    const timer=window.setTimeout(() => {if (!pending.current) void saveRef.current().catch(() => {});},1200);
    return () => window.clearTimeout(timer);
  },[readOnly,snapshot?.edits,isPending,snapshot?.saving,error]);
  const value = snapshot?.edits[0] ?? snapshot?.model ?? text;
  const status = readOnly ? '历史版本 · 只读' : error ? '保存失败' : snapshot?.saving ? '正在保存…' : snapshot?.dirty || isPending ? '未保存' : '已保存';

  return <section className="office-file-content markdown-file-content" aria-label="Markdown 文件内容" onCompositionUpdateCapture={()=>reportActivity()} onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      void save().catch(() => {});
    }
  }}>
    {toolbar ? createPortal(<>
      <span className="office-file-content__status" role="status">{status}</span>
      {!readOnly ? <Button type="button" variant="ghost" className="project-file-content__icon-button" size="sm" disabled={!snapshot || snapshot.saving || (!snapshot.dirty && !isPending)} aria-label="保存" title="立即保存（默认自动保存）" leadingIcon={<Save size={14} aria-hidden="true" />} onClick={() => void save().catch(() => {})}/> : null}
    </>, toolbar) : null}
    {error ? <p role="alert">{error}。修改已保留，请解决后重试保存。</p> : null}
    <div className="office-file-content__editor">
      <Suspense fallback={<EditorLoading format="markdown" stage="runtime" />}>
        {snapshot ? <MarkdownEditor
          documentKey={String(editorEpoch.current)} menuToolbar={menuToolbar} value={value}
          onChange={source => {
            if (readOnly) return;
            const current = session.current;
            if (!current) return;
            reportActivity();
            current.replaceEdits(source === current.snapshot.model ? [] : [source]);
            setError(undefined);
            publish();
          }}
          readOnly={readOnly} presentationMode="edit" resources={resources} resolveResource={resolveResource}
          line={line} initialView={initialView} sourceMode={sourceMode} onViewChange={onViewChange}
          registerBeforeSave={registerBeforeSave} onPendingChange={pendingChanged}
          onExport={exportEditorFile} onPrint={printEditorHtml} onRenderPdf={renderEditorPdf}
        /> : null}
      </Suspense>
    </div>
  </section>;
}
