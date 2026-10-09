import type { AgentPublishedSource, AgentScope, AgentSourceRef } from "./agent-types";

export type MemoryCategory = "background" | "domain" | "interest" | "method" | "preference" | "knowledge_pointer";
export type MemoryConfirmation = "inferred" | "user_confirmed";
export type MemoryStatus = "enabled" | "disabled";
export type MemorySourceState = "current" | "stale" | "unavailable" | "archived";

export interface AgentMemoryCard {
  nodeId: string;
  nodeRevision: number;
  policyRevision: number;
  category: MemoryCategory;
  title: string;
  oneLine: string;
  confirmation: MemoryConfirmation;
  status: MemoryStatus;
  sourceState: MemorySourceState;
  lastSupportedAt: string;
  suppressedBy: Array<{ nodeId: string; title: string }>;
}

export interface AgentMemoryDetail extends AgentMemoryCard {
  summary: string;
  bodySections: Array<{ id: string; title: string; text: string }>;
  sourceRefs: AgentSourceRef[];
  publishedSources: AgentPublishedSource[];
}

export interface AgentMemoryListInput { scope: AgentScope; cursor?: string | null; limit?: number }
export interface AgentMemoryListPage { items: AgentMemoryCard[]; nextCursor: string | null }
export interface AgentMemoryGetInput { scope: AgentScope; nodeId: string }
export type AgentMemoryAction = "confirm" | "correct" | "disable" | "reenable";
export interface AgentMemoryUpdateInput extends AgentMemoryGetInput {
  expectedNodeRevision: number;
  expectedPolicyRevision: number;
  action: AgentMemoryAction;
  correction?: { title: string; oneLine: string; summary: string;
    bodySections: Array<{ id: string; title: string; text: string }> };
}
