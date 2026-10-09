import type { AgentRuntimeOutput } from "./agent-types";

export type AgentReviewDecision = "confirm" | "cancel";
/** A native decision, retained separately from Pi conversation history. */
export interface AgentOutputReviewDecision {
  requestId: string;
  decision: AgentReviewDecision | "revise";
  text?: string;
  decidedAt: string;
}
export interface AgentOutputReviewInput {
  runId: string;
  outputs: { outputId: string; expectedRevision: number }[];
  decision: AgentReviewDecision;
  text?: string;
}
/** Metadata only; native business saves retain their individual receipts. */
export interface AgentOutputReviewResult {
  runId: string;
  decision: AgentReviewDecision;
  outputs: AgentRuntimeOutput[];
}
export interface AgentReviewExecutionResult {
  decision: AgentReviewDecision;
  outputs: AgentRuntimeOutput[];
  failures: { outputId: string; error: unknown }[];
}
