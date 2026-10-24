import type { AgentObjectRef, AgentScope } from "./agent-types";

/** Registered system handler; artwork is supplied by the host OS. */
export interface NativeFileApplication {
  id: string;
  name: string;
  icon: string | null;
  isDefault: boolean;
}

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

/** Physical file root and actual owner shared by Workspace and Project browsers. */
export interface FileBrowserScope {
  workspaceRoot: string;
  projectId: number | null;
  rootPath: string;
  name: string;
}
export function fileOwnerScope(projectId: number | null): AgentScope {
  return projectId === null ? { kind: "workspace" } : { kind: "project", projectId };
}
export function sameFileOwner(a: AgentScope, b: AgentScope) {
  return a.kind === b.kind && (a.kind === "workspace" || (b.kind === "project" && a.projectId === b.projectId));
}
