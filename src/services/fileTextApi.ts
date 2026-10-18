import type { AgentWorkspaceBinding } from '../lib/agent-types';
import type { FileBytesInput } from '../lib/file-types';
import type { DocumentVersionCommitResult } from '../lib/types';
import { callAgentCommand } from './agentApi';
export const fileTextApi = {
    save(binding: AgentWorkspaceBinding, data: FileBytesInput & {
        text: string;
    }, requestId: string) {
        return callAgentCommand<DocumentVersionCommitResult>('file_text_save', requestId, { input: { binding, requestId, data } });
    },
};
