import type { AgentWorkspaceBinding } from '../lib/agent-types';
import type { FileBytesInput } from '../lib/file-types';
import type { OfficeEdit, OfficeModel } from '../lib/office-types';
import type { OfficeSaveResult } from '../lib/office-edit-session';
import type { RecalculateRequest, RecalculateResult, OfficeViewRead } from '../../packages/office-xlsx/types';
import { callAgentCommand } from './agentApi';
export const officeFileApi = {
  inspectView(binding: AgentWorkspaceBinding, data: FileBytesInput, requestId = crypto.randomUUID()) {
    return callAgentCommand<{model:OfficeModel}>('file_office_view',requestId,{input:{binding,requestId,data:{...data,read:null}}});
  },
  async readView(binding: AgentWorkspaceBinding, data: FileBytesInput & {read:OfficeViewRead}, requestId = crypto.randomUUID()) {
    const response = await callAgentCommand<{result:unknown}>('file_office_view',requestId,{input:{binding,requestId,data}});
    return response.result;
  },
  inspect(binding: AgentWorkspaceBinding, data: FileBytesInput, requestId = crypto.randomUUID()) {
    return callAgentCommand<{model:OfficeModel}>('file_office_inspect',requestId,{input:{binding,requestId,data}});
  },
  save(binding: AgentWorkspaceBinding, data: FileBytesInput & {edits:OfficeEdit[]}, requestId: string) {
    return callAgentCommand<OfficeSaveResult<OfficeModel>>('file_office_save',requestId,{input:{binding,requestId,data}});
  },
  recalculate(binding: AgentWorkspaceBinding, data: FileBytesInput & {recalculation:RecalculateRequest}, requestId = crypto.randomUUID()) {
    return callAgentCommand<RecalculateResult>('file_office_recalculate',requestId,{input:{binding,requestId,data}});
  },
};
