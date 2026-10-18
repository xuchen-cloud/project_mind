import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Save} from 'lucide-react';
import type {AgentWorkspaceBinding} from '../../lib/agent-types';
import type {FileBytesInput} from '../../lib/file-types';
import {OfficeEditSession} from '../../lib/office-edit-session';
import {fileTextApi} from '../../services/fileTextApi';
import {exportEditorFile} from '../../services/editorExport';
import {printEditorHtml, renderEditorPdf} from '../../services/editorPrint';
import {Button} from '../../ui/components/Button';
import '../office/office-file-content.css';

const MarkdownEditor = lazy(() => import('../markdown/MarkdownEditor').then(module => ({default: module.MarkdownEditor})));

interface Props {
  toolbar: HTMLElement | null;
  binding: AgentWorkspaceBinding;
  baseline: FileBytesInput;
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
  onSaved: (version: number, hash: string, text: string) => void;
}

export function MarkdownFileContent({toolbar, binding, baseline, text, readOnly, resources, resolveResource, line, sourceMode, initialView, onViewChange, registerFlush, onDirtyChange, onSaved}: Props) {
  const session = useRef<OfficeEditSession<string, string> | null>(null);
  const saveOperation = useRef<{session: OfficeEditSession<string, string>; promise: Promise<void>} | null>(null);
  const identity = useRef('');
  const editorEpoch = useRef(0);
  const key = `${binding.workspaceId}:${binding.generation}:${baseline.versionNumber}:${baseline.expectedContentHash}`;
  const [snapshot, setSnapshot] = useState<OfficeEditSession<string, string>['snapshot']>();
  const [error, setError] = useState<string>();
  const beforeSave = useRef<(() => Promise<void>) | null>(null);
  const pending = useRef(false);
  const [isPending, setPending] = useState(false);
  const callbacks = useRef({onDirtyChange, onSaved});
  callbacks.current = {onDirtyChange, onSaved};

  function publish() {
    const next = session.current?.snapshot;
    setSnapshot(next);
    callbacks.current.onDirtyChange(!!next?.edits.length || pending.current);
  }

  useEffect(() => {
    if (identity.current === key) return;
    identity.current = key;
    editorEpoch.current++;
    pending.current = false;
    setPending(false);
    setError(undefined);
    session.current = new OfficeEditSession(baseline, text, async input => {
      const {edits, requestId, ...fixed} = input;
      const source = edits[0];
      const commit = await fileTextApi.save(binding, {...fixed, text: source}, requestId);
      return {model: source, commit};
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
    pending.current = value;
    setPending(value);
    callbacks.current.onDirtyChange(value || !!session.current?.snapshot.edits.length);
  }, []);

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
  async function performSave(current: OfficeEditSession<string, string>) {
    const epoch = identity.current;
    setError(undefined);
    try {
      if (beforeSave.current && !current.snapshot.saving) await beforeSave.current();
      if (identity.current !== epoch) return;
      const saving = current.save();
      publish();
      const result = await saving;
      if (identity.current !== epoch) return;
      // The parent acknowledges this exact baseline after publishing the receipt.
      if (result) {
        identity.current = `${binding.workspaceId}:${binding.generation}:${result.commit.receipt.versionNumber}:${result.commit.receipt.contentHash}`;
      }
      publish();
      if (result) callbacks.current.onSaved(result.commit.receipt.versionNumber, result.commit.receipt.contentHash, result.model);
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
  useEffect(() => registerFlush(() => saveRef.current()), [registerFlush]);
  const value = snapshot?.edits[0] ?? snapshot?.model ?? text;
  const status = readOnly ? '历史版本 · 只读' : snapshot?.saving ? '正在保存…' : snapshot?.edits.length || isPending ? '未保存' : '已保存';

  return <section className="office-file-content markdown-file-content" aria-label="Markdown 文件内容" onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      void save().catch(() => {});
    }
  }}>
    {toolbar ? createPortal(<>
      <span className="office-file-content__status" role="status">{status}</span>
      {!readOnly ? <Button type="button" size="sm" disabled={!snapshot || snapshot.saving || (!snapshot.edits.length && !isPending)} leadingIcon={<Save size={14} aria-hidden="true" />} onClick={() => void save().catch(() => {})}>保存</Button> : null}
    </>, toolbar) : null}
    {error ? <p role="alert">{error}。修改已保留，请解决后重试保存。</p> : null}
    <div className="office-file-content__editor">
      <Suspense fallback={<p role="status">正在加载 Markdown 编辑器…</p>}>
        {snapshot ? <MarkdownEditor
          documentKey={String(editorEpoch.current)} value={value}
          onChange={source => {
            const current = session.current;
            if (!current) return;
            current.replaceEdits(source === current.snapshot.model ? [] : [source]);
            setError(undefined);
            publish();
          }}
          readOnly={readOnly || snapshot.saving} resources={resources} resolveResource={resolveResource}
          line={line} initialView={initialView} sourceMode={sourceMode} onViewChange={onViewChange}
          registerBeforeSave={registerBeforeSave} onPendingChange={pendingChanged}
          onExport={exportEditorFile} onPrint={printEditorHtml} onRenderPdf={renderEditorPdf}
        /> : null}
      </Suspense>
    </div>
  </section>;
}
