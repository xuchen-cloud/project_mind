import type { AgentObjectRef, AgentScope, AgentWorkspaceBinding } from "./agent-types";

export interface ConnectionObjectPage {
  items: { object: AgentObjectRef; title: string }[];
  nextCursor: string | null;
}

export interface ConnectionObjectsInput {
  scope: AgentScope;
  query: string;
  cursor: string | null;
}

export interface ConnectionGrant {
  id: string;
  clientLabel: string;
  workspaceId: string;
  workspaceContent: boolean;
  allProjects: boolean;
  projectIds: number[];
  objects: AgentObjectRef[] | null;
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
  cliInstallation: {
    sourcePath: string | null;
    commandPath: string;
    profilePath: string | null;
    installed: boolean;
    pathConfigured: boolean;
    needsUpdate: boolean;
    conflict: string | null;
    manualInstruction: string | null;
  };
  cliShell: "powershell" | "posix";
  workspacePath: string | null;
  connections: ConnectionGrant[];
}

export interface ConnectionCreateData {
  clientLabel: string;
  workspaceContent: boolean;
  allProjects: boolean;
  projectIds: number[];
  sessionRead: boolean;
  writeOperations: string[];
  objects: AgentObjectRef[] | null;
}
