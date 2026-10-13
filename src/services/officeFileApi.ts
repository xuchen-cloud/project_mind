import type { AgentWorkspaceBinding } from '../lib/agent-types';
import type { FileBytesInput } from '../lib/file-types';
import type { OfficeEdit, OfficeModel } from '../lib/office-types';
import type { OfficeSaveResult } from '../lib/office-edit-session';
import { callAgentCommand } from './agentApi';
export const officeFileApi = {
  inspect(binding: AgentWorkspaceBinding, data: FileBytesInput, requestId = crypto.randomUUID()) {
    return callAgentCommand<{model:OfficeModel}>('file_office_inspect',requestId,{input:{binding,requestId,data}});
  },
  save(binding: AgentWorkspaceBinding, data: FileBytesInput & {edits:OfficeEdit[]}, requestId: string) {
    return callAgentCommand<OfficeSaveResult<OfficeModel>>('file_office_save',requestId,{input:{binding,requestId,data}});
  },
};
