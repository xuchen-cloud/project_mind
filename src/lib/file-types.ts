import type { AgentObjectRef } from "./agent-types";

export interface FileVersionMetadata {
  id: string;
  versionNumber: number;
  name: string;
  createdAt: string;
  contentHash: string | null;
  isCurrent: boolean;
}
export interface FileVersionPage {
  object: AgentObjectRef;
  currentVersionNumber: number;
  currentContentHash: string | null;
  versions: FileVersionMetadata[];
  nextCursor: number | null;
}
export interface FileVersionGetResult {
  object: AgentObjectRef;
  currentVersionNumber: number;
  currentContentHash: string | null;
  version: FileVersionMetadata;
}
export interface FileSourcePage {
  object: AgentObjectRef;
  versionNumber: number;
  contentHash: string;
  title: string;
  byteLength: number;
  format: "text" | "markdown" | "html";
  text: string;
  startChar: number;
  endChar: number;
  totalChars: number;
  nextCursor: string | null;
  complete: boolean;
}
export interface FileRestoreInput {
  object: AgentObjectRef;
  versionId: string;
  expectedVersionNumber: number;
  expectedContentHash: string;
}
