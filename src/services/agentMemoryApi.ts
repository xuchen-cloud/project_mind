import type { AgentWorkspaceBinding } from "../lib/agent-types";
import type { AgentMemoryDetail, AgentMemoryGetInput, AgentMemoryListInput, AgentMemoryListPage, AgentMemoryUpdateInput } from "../lib/agent-memory-types";
import { callAgentCommand } from "./agentApi";

export const agentMemoryApi = {
  memoryList(binding: AgentWorkspaceBinding, data: AgentMemoryListInput, requestId: string = crypto.randomUUID()): Promise<AgentMemoryListPage> {
    return callAgentCommand("agent_memory_list", requestId, { input: { binding, requestId, data } });
  },
  memoryGet(binding: AgentWorkspaceBinding, data: AgentMemoryGetInput, requestId: string = crypto.randomUUID()): Promise<AgentMemoryDetail> {
    return callAgentCommand("agent_memory_get", requestId, { input: { binding, requestId, data } });
  },
  memoryUpdate(binding: AgentWorkspaceBinding, data: AgentMemoryUpdateInput, requestId: string = crypto.randomUUID()): Promise<AgentMemoryDetail> {
    return callAgentCommand("agent_memory_update", requestId, { input: { binding, requestId, data } });
  },
};
