import type { AgentWorkspaceBinding } from "./agent-types";

export interface ConnectionGrant {
  id: string;
  clientLabel: string;
  workspaceId: string;
  workspaceContent: boolean;
  projectIds: number[];
  operations: string[];
  enabled: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export interface ExternalConnectionsStatus {
  enabled: boolean;
  running: boolean;
  binding: AgentWorkspaceBinding | null;
  cliPath: string | null;
  cliShell: "powershell" | "posix";
  workspacePath: string | null;
  connections: ConnectionGrant[];
}

export interface ConnectionCreateData {
  clientLabel: string;
  workspaceContent: boolean;
  projectIds: number[];
  sessionRead: boolean;
}
