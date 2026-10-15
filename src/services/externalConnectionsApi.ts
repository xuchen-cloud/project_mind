import type { AgentWorkspaceBinding } from "../lib/agent-types";
import type { ConnectionCreateData, ConnectionGrant, ExternalConnectionsStatus } from "../lib/external-connections-types";
import { callAgentCommand } from "./agentApi";

export const externalConnectionsApi = {
  status(requestId = crypto.randomUUID()): Promise<ExternalConnectionsStatus> {
    return callAgentCommand("agent_connections_status", requestId, { requestId });
  },
  enable(enabled: boolean, requestId = crypto.randomUUID()): Promise<ExternalConnectionsStatus> {
    return callAgentCommand("agent_connections_enable", requestId, { requestId, enabled });
  },
  installCli(requestId = crypto.randomUUID()): Promise<ExternalConnectionsStatus> {
    return callAgentCommand("agent_cli_install", requestId, { requestId });
  },
  uninstallCli(requestId = crypto.randomUUID()): Promise<ExternalConnectionsStatus> {
    return callAgentCommand("agent_cli_uninstall", requestId, { requestId });
  },
  create(binding: AgentWorkspaceBinding, data: ConnectionCreateData, requestId = crypto.randomUUID()): Promise<ConnectionGrant> {
    return callAgentCommand("agent_connection_create", requestId, { input: { binding, requestId, data } });
  },
  revoke(binding: AgentWorkspaceBinding, grantId: string, requestId = crypto.randomUUID()): Promise<ConnectionGrant> {
    return callAgentCommand("agent_connection_revoke", requestId, { input: { binding, requestId, data: { grantId } } });
  },
};
