import {useEffect} from 'react';
import type {AgentError, AgentWorkspaceBinding} from '../lib/agent-types';
import {desktopApi} from '../services/desktopApi';
import {recordDocumentApi} from '../services/recordDocumentApi';
import {useFeedbackStore} from '../state/feedback-store';

/** Archive failures remain visible even after the edited File tab is closed. */
export function useFileWorkingErrors(workspaceRoot: string | null | undefined) {
  useEffect(() => {
    if (!workspaceRoot || !('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const report = (message: string) => {
      if (!disposed) useFeedbackStore.getState().pushToast({tone:'error',title:'文件历史归档失败',detail:message});
    };
    void desktopApi.listenEvent<{binding:AgentWorkspaceBinding;error:AgentError}>('file:working-archive-error', event => {
      void recordDocumentApi.bindingGet(workspaceRoot).then(current => {
        if (event.binding.workspaceId === current.workspaceId && event.binding.generation === current.generation) report(event.error.message);
      }).catch(error => report(error instanceof Error ? error.message : String(error)));
    }).then(unlisten => {if (disposed) unlisten();else stop=unlisten;}).catch(error => report(error instanceof Error ? error.message : String(error)));
    return () => {disposed=true;stop?.();};
  },[workspaceRoot]);
}
