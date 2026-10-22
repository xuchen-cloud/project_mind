import type {AgentObjectRef, AgentWorkspaceBinding} from '../lib/agent-types';
import type {OfficeSelectionFormat} from '../lib/office-selection';
import {callAgentCommand} from './agentApi';
import {desktopApi} from './desktopApi';

export interface OfficeSelectionRequest {
  binding: AgentWorkspaceBinding;
  editorId: string;
  selectionId: string;
  requestId: string;
  change: unknown;
}
type Receipt = Pick<OfficeSelectionRequest, 'editorId' | 'selectionId' | 'requestId'>;
function call(command: string, binding: AgentWorkspaceBinding, data: unknown) {
  const requestId = crypto.randomUUID();
  return callAgentCommand<void>(command, requestId, {input: {binding, requestId, data}});
}
export const officeSelectionApi = {
  register(binding: AgentWorkspaceBinding, data: {object: AgentObjectRef; editorId: string; selectionId: string; format: OfficeSelectionFormat; text: string; label: string}) {
    return call('office_selection_register', binding, data);
  },
  bind(binding: AgentWorkspaceBinding, data: {selectionId: string; sessionId: string}) {
    return call('office_selection_bind', binding, data);
  },
  unregister(binding: AgentWorkspaceBinding, editorId: string) {
    return call('office_selection_unregister', binding, {editorId});
  },
  claim(binding: AgentWorkspaceBinding, data: Receipt) {
    return call('office_selection_claim', binding, data);
  },
  reply(binding: AgentWorkspaceBinding, data: Receipt & {text?: string; error?: string}) {
    return call('office_selection_reply', binding, data);
  },
  listen(callback: (request: OfficeSelectionRequest) => void) {
    return desktopApi.listenEvent<OfficeSelectionRequest>('mind:office-selection-edit', callback);
  },
};
