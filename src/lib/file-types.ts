import type { AgentObjectRef } from "./agent-types";

/** Exact retained bytes: never falls back to the latest version or live path. */
export interface FileBytesInput {
  object: AgentObjectRef;
  versionNumber: number;
  expectedContentHash: string;
}
export interface FileBytesResult {
  object: AgentObjectRef;
  versionNumber: number;
  contentHash: string;
  name: string;
  mime: string;
  byteLength: number;
  base64: string;
}
export interface ProjectDirectoryFile {
  object: AgentObjectRef;
  relativePath: string;
  name: string;
  versionNumber: number;
  contentHash: string | null;
  state: "ready" | "missing" | "ambiguous" | "unavailable";
  reason: string | null;
}
export interface ProjectDirectoryScanResult {
  files: ProjectDirectoryFile[];
  failures: { relativePath: string; reason: string }[];
  excluded: { relativePath: string; reason: "internal" | "symlink" | "special" }[];
  nextCursor: string | null;
  complete: boolean;
  cancelled: boolean;
}

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
