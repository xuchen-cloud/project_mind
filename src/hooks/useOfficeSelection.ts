import {useCallback, useEffect, useRef, useState} from 'react';
import type {AgentObjectRef, AgentWorkspaceBinding} from '../lib/agent-types';
import {officeSelectionError, type OfficeSelectionController, type OfficeSelectionFormat} from '../lib/office-selection';
import {getContentLayout} from '../lib/project-content-layout';
import {requestDshOfficeSelection, useDshFileReferences} from '../lib/dsh-host-events';
import {useFeedbackStore} from '../state/feedback-store';
import {useProjectContentStore} from '../state/project-content-store';
import {officeSelectionApi, type OfficeSelectionRequest} from '../services/officeSelectionApi';
import {dshAssistantApi} from '../services/dshAssistantApi';
import {recordDocumentApi} from '../services/recordDocumentApi';
import {openProjectContent} from '../services/projectContentApi';

interface Props {
  binding: AgentWorkspaceBinding;
  object: AgentObjectRef;
  format?: OfficeSelectionFormat;
  label: string;
  enabled: boolean;
  writable: boolean;
  /** Changes on a committed model replacement, which invalidates renderer targets. */
  model: unknown;
  prepareCapture(): Promise<boolean>;
}
interface Owner {
  editorId: string;
  binding: AgentWorkspaceBinding;
  controller: OfficeSelectionController;
  root: string | null;
  signal: AbortController;
  selectionId?: string;
  registered: boolean;
  listening: Promise<void>;
}
const sameBinding = (a: AgentWorkspaceBinding, b: AgentWorkspaceBinding) => a.workspaceId === b.workspaceId && a.generation === b.generation;

export function useOfficeSelection(props: Props) {
  const latest = useRef(props); latest.current = props;
  const [controller, setController] = useState<OfficeSelectionController | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const quoting = useRef(false);
  const owner = useRef<Owner | undefined>(undefined);
  const workspaceRoot = useDshFileReferences(state => state.workspaceRoot);
  const registerSelection = useCallback((next: OfficeSelectionController) => {
    setController(next);
    return () => setController(current => current === next ? null : current);
  }, []);
  const identity = JSON.stringify([props.binding, props.object]);
  function assertOwner(current: Owner, requireWritable = true) {
    if (owner.current !== current || current.signal.signal.aborted || !latest.current.enabled || !sameBinding(current.binding, latest.current.binding)
      || useDshFileReferences.getState().workspaceRoot !== current.root) throw Error('Office 文件或工作区已切换，请重新引用选区');
    if (requireWritable && !latest.current.writable) throw Error('Office 文件只读或正在保存，请稍后重新引用');
  }
  useEffect(() => {
    if (!props.enabled || !controller || !props.format) return;
    const current: Owner = {editorId: crypto.randomUUID(), binding: props.binding, controller, root: useDshFileReferences.getState().workspaceRoot,
      signal: new AbortController(), registered: false, listening: Promise.resolve()};
    owner.current = current;
    let unlisten: (() => void) | undefined;
    async function receive(request: OfficeSelectionRequest) {
      if (request.editorId !== current.editorId || request.selectionId !== current.selectionId || !sameBinding(request.binding, current.binding)) return;
      const receipt = {editorId: request.editorId, selectionId: request.selectionId, requestId: request.requestId};
      let claimed = false;
      try {
        assertOwner(current, false);
        await officeSelectionApi.claim(current.binding, receipt); claimed = true;
        assertOwner(current);
        const result = await current.controller.applySelection({selectionId: request.selectionId, change: request.change});
        // The edit has completed. Autosave may now make the editor temporarily
        // read-only; that must not turn an applied draft into a false failure.
        // The native receipt remains bound to this exact editor and attempt.
        await officeSelectionApi.reply(current.binding, {...receipt, text: result.text});
      } catch (reason) {
        const message = officeSelectionError(reason);
        if (owner.current === current) setError(message);
        if (claimed) {
          try {await officeSelectionApi.reply(current.binding, {...receipt, error: message});}
          catch (replyError) {if (owner.current === current) setError(`${message}；回执失败：${officeSelectionError(replyError)}`);}
        }
      }
    }
    current.listening = officeSelectionApi.listen(request => {void receive(request);}).then(stop => {
      if (current.signal.signal.aborted) stop(); else unlisten = stop;
    });
    void current.listening.catch(reason => {if (owner.current === current) setError(officeSelectionError(reason));});
    return () => {
      current.signal.abort(); unlisten?.();
      if (owner.current === current) owner.current = undefined;
      if (current.registered) void officeSelectionApi.unregister(current.binding, current.editorId).catch(reason => useFeedbackStore.getState().pushToast({tone: 'error', title: '选区引用清理失败', detail: officeSelectionError(reason)}));
    };
  }, [identity, props.enabled, props.format, props.model, controller, workspaceRoot]);

  async function quoteSelection() {
    if (quoting.current) return;
    quoting.current = true; setBusy(true); setError(undefined);
    let current = owner.current;
    try {
      if (!current) throw Error('Office 编辑器尚未加载');
      const input = latest.current;
      if (!current.root || input.object.scope.kind !== 'project' || !input.format) throw Error('请在项目中打开文件后引用选区');
      const root = current.root, projectId = input.object.scope.projectId;
      const scope = {workspaceId: input.binding.workspaceId, projectId};
      if (!await input.prepareCapture()) throw Error('文件已保存，请重新选择内容后再次引用选区');
      assertOwner(current);
      await current.listening; assertOwner(current);
      const captured = await current.controller.captureSelection(); assertOwner(current);
      await officeSelectionApi.register(current.binding, {object: input.object, editorId: current.editorId, ...captured, format: input.format, label: input.label});
      current.registered = true; current.selectionId = captured.selectionId; assertOwner(current);
      const verify = async () => {
        assertOwner(current!);
        const binding = await recordDocumentApi.bindingGet(root);
        assertOwner(current!);
        if (!sameBinding(binding, input.binding)) throw Error('工作区已切换，请重新引用选区');
      };
      await verify();
      await dshAssistantApi.start(`${input.binding.workspaceId}:${input.binding.generation}`, projectId); await verify();
      const sessions = await dshAssistantApi.sessions(projectId); await verify();
      const layout = getContentLayout(useProjectContentStore.getState(), scope);
      const fileTab = layout.tabs.find(tab => tab.object.kind === 'file' && String(tab.object.id) === input.object.id);
      if (!fileTab) throw Error('文件标签已关闭，请重新打开');
      const filePane = layout.panes.find(pane => pane.tabIds.includes(fileTab.id))!;
      const other = layout.panes.find(pane => pane.id !== filePane.id);
      const opened = layout.tabs.filter(tab => tab.object.kind === 'session');
      const available = (tabId: string | null | undefined) => opened.find(tab => tab.id === tabId && sessions.some(session => session.id === tab.object.id && !session.running));
      const selected = available(other?.selectedTabId) ?? opened.find(tab => sessions.some(session => session.id === tab.object.id && !session.running));
      const sessionId = selected ? String(selected.object.id) : await dshAssistantApi.selectSession(null, projectId);
      await verify();
      await officeSelectionApi.bind(current.binding, {selectionId: captured.selectionId, sessionId}); assertOwner(current);
      // A new split moves the current document to the right. Keep both surfaces visible.
      const targetPane = other?.id ?? 'left';
      await openProjectContent({workspaceRoot: root, projectId, object: {kind: 'session', id: sessionId, title: '新会话'},
        paneId: targetPane, expectedBinding: input.binding, signal: current.signal.signal,
        beforeOpen: () => {
          assertOwner(current!);
          const store = useProjectContentStore.getState();
          const currentLayout = getContentLayout(store, scope);
          const currentFilePane = currentLayout.panes.find(pane => pane.tabIds.includes(fileTab.id));
          if (currentFilePane?.selectedTabId !== fileTab.id || currentFilePane.id !== filePane.id || currentLayout.panes.length !== layout.panes.length) {
            throw Error('文件布局已变化，请重新引用选区');
          }
          if (!other) store.split(scope);
          if (selected) store.move(scope, selected.id, targetPane);
          requestDshOfficeSelection(projectId, input.label, sessionId, {selectionId: captured.selectionId, format: input.format!});
        }});
    } catch (reason) {
      setError(officeSelectionError(reason));
      if (current?.registered) {
        current.registered = false; current.selectionId = undefined;
        try {await officeSelectionApi.unregister(current.binding, current.editorId);}
        catch (cleanupError) {setError(`${officeSelectionError(reason)}；清理失败：${officeSelectionError(cleanupError)}`);}
      }
    } finally {quoting.current = false; setBusy(false);}
  }
  return {registerSelection, quoteSelection, busy, error, available: !!controller && props.enabled};
}
