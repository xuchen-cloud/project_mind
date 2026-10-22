import type { AgentScope, AgentWorkspaceBinding, AgentSourceRef } from "../lib/agent-types";
import { desktopApi } from "./desktopApi";

export type MemoryScope = AgentScope;
export type MemoryCategory = "background" | "domain" | "interest" | "method" | "preference" | "knowledge_pointer" | "agreement" | "decision";
export interface MemorySource {
  kind: "message" | "file" | "record"; id: string; scope: MemoryScope; label: string; excerpt: string;
  sessionId?: string; messageId?: string;
  reference?: AgentSourceRef;
  availability?: "available" | "source_removed" | "access_denied" | "unverified";
}
export interface MemoryFact {
  id: string; scope: MemoryScope; category: MemoryCategory; content: string; condition: string | null;
  core: boolean; state: "active" | "disabled" | "forgotten" | "superseded";
  confirmation: "confirmed" | "inferred"; revision: number; validFrom: string | null; validTo: string | null;
  supersededBy: string | null; sources: MemorySource[]; locked: boolean; autoOrganizedAt: string | null; rollbackId: string | null;
}
interface MemoryFields { content?: string; condition?: string | null; core?: boolean; validFrom?: string | null; validTo?: string | null }
export type MemoryChange =
  | ({ action: "add"; scope: MemoryScope; content: string; category: MemoryCategory } & MemoryFields)
  | ({ action: "patch"; scope: MemoryScope; id: string; expectedRevision: number } & MemoryFields)
  | { action: "disable" | "enable" | "forget"; scope: MemoryScope; id: string; expectedRevision: number }
  | ({ action: "merge"; scope: MemoryScope; id: string; expectedRevision: number; content: string; from: { id: string; expectedRevision: number }[] } & Pick<MemoryFields, "condition">);
export interface MemoryProposal { id: string; createdAt: string; changes: MemoryChange[] }
export interface MemorySettings { requireApproval: boolean }
export interface MemoryList { facts: MemoryFact[]; proposals: MemoryProposal[]; settings: MemorySettings }
export interface MemoryApplyResult { facts: MemoryFact[]; receipt: string; pending: boolean; proposalId: string | null }
export type MemoryRequest =
  | { operation: "list"; scope: MemoryScope; includeInactive?: boolean }
  | { operation: "apply"; requestId: string; changes: MemoryChange[] }
  | { operation: "rollback"; requestId: string; rollbackId: string }
  | { operation: "approve" | "reject"; requestId: string; proposalId: string }
  | { operation: "settings"; requireApproval: boolean };
export const memoryApi = {
  execute: <T = MemoryList | MemoryApplyResult | MemorySettings>(binding: AgentWorkspaceBinding, scope: MemoryScope, request: MemoryRequest) => desktopApi.command<T>("memory_execute", { binding, scope, request }),
  adoption: (binding: AgentWorkspaceBinding, scope: MemoryScope, sessionId: string, turn: number) => desktopApi.command<MemoryAdoption[]>("memory_adoption_get", { binding, scope, sessionId, turn }),
};
export interface MemoryAdoption {
  requestId: string; adoptedAt: string;
  snapshot: { turn: number; step: number; facts: { id: string; content: string; revision: number; condition: string | null }[]; omittedIds: string[]; strategy: string; budgetChars: number };
}
